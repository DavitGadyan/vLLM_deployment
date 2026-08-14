"use client";

import * as React from "react";

import { Composer } from "@/components/chat/composer";
import { MessageBubble } from "@/components/chat/message-bubble";
import { Button } from "@/components/ui/button";
import { ChatIcon } from "@/components/ui/icons";
import { useChat } from "@/lib/use-chat";

const SUGGESTIONS = [
  "How long do I have to return something?",
  "How fast is express shipping?",
  "Is water damage covered by the warranty?",
];

export function ChatPanel() {
  const { messages, isStreaming, send, stop, retryLast, reset } = useChat();
  const endRef = React.useRef<HTMLDivElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const pinnedToBottom = React.useRef(true);

  // Follow new tokens, but stop following the moment the user scrolls up to
  // re-read something. Yanking the viewport back down mid-read is the most
  // irritating thing a streaming chat UI can do.
  React.useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onScroll = () => {
      const distance =
        element.scrollHeight - element.scrollTop - element.clientHeight;
      pinnedToBottom.current = distance < 80;
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, []);

  React.useEffect(() => {
    if (pinnedToBottom.current) {
      endRef.current?.scrollIntoView({ block: "end" });
    }
  }, [messages]);

  const isEmpty = messages.length === 0;

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
          {isEmpty ? (
            <EmptyState onPick={send} />
          ) : (
            <div
              className="flex flex-col gap-6"
              role="log"
              aria-live="polite"
              aria-label="Conversation"
            >
              {messages.map((message, index) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  onRetry={
                    index === messages.length - 1 && message.error
                      ? retryLast
                      : undefined
                  }
                />
              ))}
            </div>
          )}
          <div ref={endRef} />
        </div>
      </div>

      {!isEmpty ? (
        <div className="border-t border-border bg-surface px-4 py-2 sm:px-6">
          <div className="mx-auto flex w-full max-w-3xl justify-end">
            <Button variant="ghost" size="sm" onClick={reset}>
              New conversation
            </Button>
          </div>
        </div>
      ) : null}

      <Composer onSend={send} onStop={stop} isStreaming={isStreaming} />
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex flex-col items-center py-16 text-center">
      <span className="flex size-10 items-center justify-center rounded-lg border border-border text-tertiary">
        <ChatIcon className="size-5" />
      </span>
      <h2 className="mt-4 text-base font-semibold text-primary">
        Test the assistant
      </h2>
      <p className="mt-1.5 max-w-md text-sm leading-relaxed text-secondary">
        Answers come from your indexed documents and the policies set in
        Configuration. When the assistant cannot answer from those, it hands off
        to a person rather than guessing.
      </p>

      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onPick(suggestion)}
            className="rounded-full border border-border px-3 py-1.5 text-xs text-secondary transition-colors hover:border-border-strong hover:text-primary"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}
