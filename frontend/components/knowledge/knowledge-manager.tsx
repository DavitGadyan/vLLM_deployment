"use client";

import * as React from "react";

import { Badge, StatusDot } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertIcon, TrashIcon, UploadIcon } from "@/components/ui/icons";
import { useToast } from "@/components/ui/toast";
import { api, ApiError } from "@/lib/api";
import type { DocumentStatus, KnowledgeDocument } from "@/lib/types";
import { cn, formatBytes, formatRelative } from "@/lib/utils";

const ACCEPTED = ".pdf,.md,.markdown,.txt,.html,.htm";
const POLL_MS = 2000;

const STATUS: Record<
  DocumentStatus,
  { label: string; tone: "success" | "warning" | "danger" | "neutral" }
> = {
  ready: { label: "Indexed", tone: "success" },
  processing: { label: "Indexing", tone: "warning" },
  pending: { label: "Queued", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" },
};

export function KnowledgeManager({ initial }: { initial: KnowledgeDocument[] }) {
  const { toast } = useToast();
  const [documents, setDocuments] = React.useState(initial);
  const [uploading, setUploading] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const hasPending = documents.some(
    (doc) => doc.status === "pending" || doc.status === "processing",
  );

  // Ingestion is asynchronous, so poll while anything is in flight — and only
  // then. A permanent 2-second poll on an idle page is wasted traffic.
  React.useEffect(() => {
    if (!hasPending) return;
    const timer = window.setInterval(async () => {
      try {
        setDocuments(await api.listDocuments());
      } catch {
        // Transient failure; the next tick retries.
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [hasPending]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const result = await api.uploadDocument(file);
        if (result.created) {
          toast({
            tone: "success",
            title: `${file.name} uploaded`,
            description: "Indexing now — it becomes searchable in a few seconds.",
          });
        } else {
          toast({
            tone: "info",
            title: `${file.name} is already indexed`,
            description: "The file content matches a document already uploaded.",
          });
        }
      }
      setDocuments(await api.listDocuments());
    } catch (error) {
      toast({
        tone: "error",
        title: "Upload failed",
        description:
          error instanceof ApiError ? error.message : "Check the file and try again.",
      });
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function remove(doc: KnowledgeDocument) {
    // Deleting removes chunks the assistant may currently be citing, so it is
    // worth one confirmation rather than an undo nobody finds in time.
    if (!window.confirm(`Delete "${doc.title}"? The assistant will stop citing it.`)) {
      return;
    }
    try {
      await api.deleteDocument(doc.id);
      setDocuments((current) => current.filter((item) => item.id !== doc.id));
      toast({ tone: "success", title: `${doc.title} deleted` });
    } catch {
      toast({ tone: "error", title: "Could not delete that document" });
    }
  }

  const readyCount = documents.filter((doc) => doc.status === "ready").length;
  const totalChunks = documents.reduce((sum, doc) => sum + doc.chunk_count, 0);

  return (
    <div className="space-y-6">
      {readyCount === 0 ? (
        <div className="flex items-start gap-2.5 rounded-md border border-warning/40 bg-warning-subtle px-4 py-3">
          <AlertIcon className="mt-0.5 size-4 shrink-0 text-warning-text" />
          <p className="text-xs leading-relaxed text-warning-text">
            Nothing is indexed yet, so the assistant escalates every question to a
            human rather than guessing. Upload your policy documents to give it
            something to answer from.
          </p>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Upload documents</CardTitle>
          <CardDescription>
            PDF, Markdown, HTML or plain text. Documents are split into passages
            and embedded so the assistant can quote and cite them. Scanned PDFs
            need OCR first — there is no text to extract.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              void upload(event.dataTransfer.files);
            }}
            className={cn(
              "flex flex-col items-center rounded-lg border border-dashed px-6 py-10 text-center transition-colors",
              dragging ? "border-accent bg-accent-subtle" : "border-border",
            )}
          >
            <UploadIcon className="size-5 text-tertiary" />
            <p className="mt-3 text-sm text-primary">
              Drag files here, or{" "}
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="rounded-sm font-medium text-accent-text underline-offset-4 hover:underline"
              >
                browse
              </button>
            </p>
            <p className="mt-1 text-xs text-tertiary">Up to 20 MB per file</p>

            {/* Keyboard and screen-reader path to the same action. */}
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={ACCEPTED}
              className="sr-only"
              aria-label="Upload knowledge base documents"
              disabled={uploading}
              onChange={(event) => void upload(event.target.files)}
            />
          </div>

          {uploading ? (
            <p className="mt-3 text-xs text-secondary" aria-live="polite">
              Uploading…
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle>Indexed documents</CardTitle>
            {documents.length > 0 ? (
              <Badge variant="neutral">
                {totalChunks.toLocaleString()} passage
                {totalChunks === 1 ? "" : "s"}
              </Badge>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {documents.length === 0 ? (
            <p className="px-5 py-8 text-center text-xs text-tertiary">
              No documents yet.
            </p>
          ) : (
            <table className="w-full text-sm">
              <caption className="sr-only">Knowledge base documents</caption>
              <thead>
                <tr className="border-b border-border text-left">
                  <th scope="col" className="px-5 py-2 text-xs font-medium text-secondary">
                    Document
                  </th>
                  <th scope="col" className="px-3 py-2 text-xs font-medium text-secondary">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-secondary">
                    Passages
                  </th>
                  <th scope="col" className="px-3 py-2 text-xs font-medium text-secondary">
                    Added
                  </th>
                  <th scope="col" className="px-5 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {documents.map((doc) => (
                  <tr key={doc.id}>
                    <td className="max-w-0 px-5 py-3">
                      <p className="truncate font-medium text-primary">{doc.title}</p>
                      <p className="truncate text-xs text-tertiary">
                        {doc.filename} · {formatBytes(doc.size_bytes)}
                      </p>
                      {doc.error ? (
                        <p className="mt-1 text-xs text-danger-text">{doc.error}</p>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3">
                      <span className="inline-flex items-center gap-1.5 text-xs text-secondary">
                        <StatusDot tone={STATUS[doc.status].tone} />
                        {STATUS[doc.status].label}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-right text-xs tabular-nums text-secondary">
                      {doc.chunk_count || "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-xs text-tertiary">
                      {formatRelative(doc.created_at)}
                    </td>
                    <td className="px-5 py-3 text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-8 hover:text-danger-text"
                        onClick={() => remove(doc)}
                        aria-label={`Delete ${doc.title}`}
                      >
                        <TrashIcon />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
