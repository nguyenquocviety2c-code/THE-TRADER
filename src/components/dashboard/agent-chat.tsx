"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { vi } from "date-fns/locale";
import { Bot, Info, Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { RateLimitError, useAgentChat } from "@/hooks/use-agent-actions";
import type { AgentChatMessageRow } from "@/lib/types";

interface AgentChatProps {
  agentId: string;
  agentName: string;
  /** Thread thật từ GET /api/agents/[id] .chat (asc) — refetch sau mỗi mutation. */
  initialMessages: AgentChatMessageRow[];
}

const MAX_LEN = 500;

/**
 * PHASE3_BLUEPRINT §4.7 — thread chat 1-1 với agent (tab "Chat" của detail
 * panel). Optimistic tin USER khi gửi, rate-limit 429 → đếm ngược, LLM lỗi
 * (200 + reply null) → toast + refetch thread thật.
 */
export function AgentChat({ agentId, agentName, initialMessages }: AgentChatProps) {
  const chat = useAgentChat(agentId);

  // Tin nằm ngoài thread server: optimistic USER tạm + tin đã trả lời chờ refetch.
  const [extra, setExtra] = useState<AgentChatMessageRow[]>([]);
  const [text, setText] = useState("");
  const [countdown, setCountdown] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Khi server cập nhật thread (invalidate → refetch), lọc các tin trùng id
  // NGAY KHI RENDER (không cần sync state) — tránh hiển thị trùng lặp.
  const serverIds = useMemo(
    () => new Set(initialMessages.map((m) => m.id)),
    [initialMessages]
  );
  const visibleExtra = useMemo(
    () => extra.filter((m) => !serverIds.has(m.id)),
    [extra, serverIds]
  );

  const thread = useMemo(
    () => [...initialMessages, ...visibleExtra],
    [initialMessages, visibleExtra]
  );

  // Đếm ngược rate-limit (60s/agent) — tick giảm mỗi giây.
  const counting = countdown > 0;
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(
      () => setCountdown((c) => Math.max(0, c - 1)),
      1000
    );
    return () => clearInterval(timer);
  }, [counting]);

  // Auto-scroll xuống cuối khi có tin mới / đang chờ trả lời.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [thread.length, chat.isPending]);

  const canSend = text.trim().length > 0 && !chat.isPending && !counting;

  function send() {
    const message = text.trim();
    if (!message || chat.isPending || counting) return;
    // Optimistic: append tạm tin USER, đợi response thay bằng tin thật.
    const temp: AgentChatMessageRow = {
      id: `temp-${Date.now()}`,
      direction: "USER",
      content: message,
      createdAt: new Date().toISOString(),
    };
    setExtra((cur) => [...cur, temp]);
    setText("");
    chat.mutate(message, {
      onSuccess: (res) => {
        setExtra((cur) => [
          ...cur.filter((m) => !m.id.startsWith("temp-")),
          res.userMessage,
          ...(res.reply ? [res.reply] : []),
        ]);
      },
      onError: (err) => {
        // 429 → đếm ngược; tin user chưa được lưu → bỏ optimistic, trả chữ về input.
        setExtra((cur) => cur.filter((m) => !m.id.startsWith("temp-")));
        setText(message);
        if (err instanceof RateLimitError) {
          setCountdown(err.retryAfterSeconds);
        }
      },
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Thread */}
      <div className="flex min-h-32 flex-col">
        {thread.length === 0 && !chat.isPending ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Chưa có tin nhắn — hãy hỏi {agentName} điều bạn muốn biết về thị
            trường.
          </p>
        ) : (
          <ul className="flex max-h-96 flex-col gap-3 overflow-y-auto custom-scrollbar pr-1">
            {thread.map((m) => (
              <li
                key={m.id}
                className={cn(
                  "flex gap-2",
                  m.direction === "USER" ? "justify-end" : "justify-start"
                )}
              >
                {m.direction === "AGENT" && (
                  <span
                    className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted"
                    title={agentName}
                  >
                    <Bot className="size-4 text-foreground/80" aria-hidden="true" />
                  </span>
                )}
                <div
                  className={cn(
                    "max-w-[85%] rounded-lg px-3 py-2",
                    m.direction === "USER"
                      ? "bg-primary/10"
                      : "bg-muted/60"
                  )}
                >
                  {m.direction === "USER" && (
                    <p className="mb-0.5 text-[10px] font-medium text-muted-foreground">
                      Bạn
                    </p>
                  )}
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">
                    {m.content}
                  </p>
                  <p className="mt-1 text-right text-[10px] text-muted-foreground">
                    {formatDistanceToNow(new Date(m.createdAt), {
                      addSuffix: true,
                      locale: vi,
                    })}
                  </p>
                </div>
              </li>
            ))}
            {chat.isPending && (
              <li className="flex gap-2" aria-live="polite">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
                  <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
                </span>
                <p className="animate-pulse self-center text-sm text-muted-foreground">
                  {agentName} đang trả lời…
                </p>
              </li>
            )}
            <div ref={bottomRef} aria-hidden="true" />
          </ul>
        )}
      </div>

      {/* Input + gửi */}
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={MAX_LEN}
          placeholder={`Hỏi ${agentName}…`}
          aria-label="Nội dung tin nhắn"
          disabled={chat.isPending || counting}
          autoComplete="off"
        />
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground" aria-hidden="true">
          {text.length}/{MAX_LEN}
        </span>
        <Button
          type="submit"
          className="h-11 shrink-0 px-4"
          disabled={!canSend}
          aria-label={counting ? `Gửi lại sau ${countdown} giây` : "Gửi tin nhắn"}
          title={
            counting
              ? `Vui lòng đợi thêm ${countdown} giây`
              : "Gửi tin nhắn cho agent"
          }
        >
          {counting ? (
            `Chờ ${countdown}s`
          ) : chat.isPending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Send className="size-4" aria-hidden="true" />
          )}
        </Button>
      </form>

      <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <Info className="size-3 shrink-0" aria-hidden="true" />
        {/* AUD-CODE #25: không hardcode giá — Space Bunny Free $0, GLM-4.6 khác; chi phí thật xem chip AI ở footer */}
        Trả lời dựa trên dữ liệu thật trong hệ thống · chi phí theo model runtime (chip AI ở footer)
      </p>
    </div>
  );
}
