"""Document parsing and chunking.

Chunk boundaries decide what the model can cite. Two rules drive the
implementation:

**Never split mid-sentence.** A chunk ending "...refunds are issued within" is
worse than useless — it retrieves on the right terms and then supplies a
truncated fact, which is exactly how a grounded assistant states a wrong number.

**Carry the heading trail.** A chunk reading "Not covered under this policy" is
meaningless without knowing it sits under "Warranty > Exclusions". The trail is
prepended to the embedded text so retrieval sees the context, and stored
separately so the citation chip can show the user where the answer came from.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass

from app.services.tokens import count_tokens

_HEADING = re.compile(r"^(#{1,6})\s+(.*\S)\s*$")
# Split on sentence-final punctuation followed by whitespace and a capital or
# digit. Avoids splitting on "e.g." and decimal points.
_SENTENCE = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(\[])")
_WHITESPACE = re.compile(r"[ \t]+")
_BLANK_LINES = re.compile(r"\n{3,}")


@dataclass(frozen=True)
class TextChunk:
    ordinal: int
    text: str
    heading: str | None
    token_count: int

    @property
    def embedding_text(self) -> str:
        """What actually gets embedded — heading trail included."""
        return f"{self.heading}\n\n{self.text}" if self.heading else self.text


class UnsupportedDocument(ValueError):
    pass


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def parse(data: bytes, content_type: str, filename: str) -> str:
    """Extract plain text from an uploaded file."""
    suffix = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

    if content_type == "application/pdf" or suffix == "pdf":
        return _parse_pdf(data)
    if content_type in {"text/html", "application/xhtml+xml"} or suffix in {"html", "htm"}:
        return _parse_html(data)
    if content_type.startswith("text/") or suffix in {"txt", "md", "markdown", "rst", "csv"}:
        return _normalise(data.decode("utf-8", errors="replace"))

    raise UnsupportedDocument(
        f"unsupported document type '{content_type}' ({filename}). "
        "Supported: PDF, HTML, Markdown, plain text."
    )


def _parse_pdf(data: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    pages: list[str] = []
    for number, page in enumerate(reader.pages, start=1):
        text = (page.extract_text() or "").strip()
        if text:
            # Page markers survive into the heading trail, so a citation can
            # point a support lead at the right page of the source PDF.
            pages.append(f"## Page {number}\n\n{text}")
    if not pages:
        raise UnsupportedDocument(
            "no extractable text in this PDF — it is probably a scan. Run OCR before uploading."
        )
    return _normalise("\n\n".join(pages))


def _parse_html(data: bytes) -> str:
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(data.decode("utf-8", errors="replace"), "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "header", "noscript"]):
        tag.decompose()

    parts: list[str] = []
    for element in soup.find_all(["h1", "h2", "h3", "h4", "p", "li", "td", "pre"]):
        text = element.get_text(" ", strip=True)
        if not text:
            continue
        if element.name.startswith("h"):
            parts.append(f"{'#' * int(element.name[1])} {text}")
        elif element.name == "li":
            parts.append(f"- {text}")
        else:
            parts.append(text)
    return _normalise("\n\n".join(parts))


def _normalise(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _WHITESPACE.sub(" ", text)
    return _BLANK_LINES.sub("\n\n", text).strip()


# ---------------------------------------------------------------------------
# Chunking
# ---------------------------------------------------------------------------


def chunk(text: str, *, chunk_tokens: int = 512, overlap_tokens: int = 64) -> list[TextChunk]:
    """Split into overlapping, heading-aware chunks.

    Overlap exists so a fact that straddles a boundary is fully present in at
    least one chunk. It is applied in whole sentences, not tokens, for the same
    reason boundaries are: a half-sentence of overlap adds noise to the
    embedding without making the fact retrievable.
    """
    chunks: list[TextChunk] = []
    ordinal = 0

    for heading, body in _split_by_heading(text):
        sentences = _split_sentences(body)
        if not sentences:
            continue

        current: list[str] = []
        current_tokens = 0

        for sentence in sentences:
            sentence_tokens = count_tokens(sentence)

            # A single sentence longer than the budget (tables, dense legal
            # prose) is emitted alone rather than dropped or split mid-clause.
            if sentence_tokens > chunk_tokens:
                if current:
                    chunks.append(_make(ordinal, current, heading))
                    ordinal += 1
                    current, current_tokens = [], 0
                chunks.append(_make(ordinal, [sentence], heading))
                ordinal += 1
                continue

            if current_tokens + sentence_tokens > chunk_tokens and current:
                chunks.append(_make(ordinal, current, heading))
                ordinal += 1
                current = _tail_for_overlap(current, overlap_tokens)
                current_tokens = sum(count_tokens(s) for s in current)

            current.append(sentence)
            current_tokens += sentence_tokens

        if current:
            chunks.append(_make(ordinal, current, heading))
            ordinal += 1

    return chunks


def _make(ordinal: int, sentences: list[str], heading: str | None) -> TextChunk:
    text = " ".join(sentences).strip()
    return TextChunk(ordinal=ordinal, text=text, heading=heading, token_count=count_tokens(text))


def _tail_for_overlap(sentences: list[str], overlap_tokens: int) -> list[str]:
    """Take whole sentences from the end, up to the overlap budget."""
    if overlap_tokens <= 0:
        return []
    tail: list[str] = []
    total = 0
    for sentence in reversed(sentences):
        tokens = count_tokens(sentence)
        if total + tokens > overlap_tokens:
            break
        tail.insert(0, sentence)
        total += tokens
    return tail


def _split_by_heading(text: str) -> list[tuple[str | None, str]]:
    """Group body text under its heading trail ("Warranty > Exclusions")."""
    sections: list[tuple[str | None, str]] = []
    trail: list[str] = []
    buffer: list[str] = []

    def flush() -> None:
        body = "\n".join(buffer).strip()
        if body:
            sections.append((" > ".join(trail) if trail else None, body))

    for line in text.splitlines():
        match = _HEADING.match(line)
        if match:
            flush()
            buffer = []
            level = len(match.group(1))
            trail = trail[: level - 1]
            # Pad when a document skips a level (h1 then h3).
            while len(trail) < level - 1:
                trail.append("")
            trail.append(match.group(2))
            trail = [part for part in trail if part]
        else:
            buffer.append(line)

    flush()
    return sections or [(None, text)]


def _split_sentences(text: str) -> list[str]:
    sentences: list[str] = []
    for paragraph in text.split("\n\n"):
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        # List items are their own units; merging them into prose sentences
        # destroys the structure that makes procedures readable.
        if paragraph.lstrip().startswith(("-", "*", "•")) or re.match(r"^\d+\.", paragraph):
            sentences.extend(line.strip() for line in paragraph.splitlines() if line.strip())
        else:
            sentences.extend(part.strip() for part in _SENTENCE.split(paragraph) if part.strip())
    return sentences
