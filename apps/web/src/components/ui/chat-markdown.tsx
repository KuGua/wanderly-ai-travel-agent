"use client";

import { type ReactNode, useMemo } from "react";

type Token =
  | { type: "paragraph"; children: InlineNode[] }
  | { type: "heading"; level: 1 | 2 | 3; children: InlineNode[] }
  | { type: "code_block"; lang: string; code: string }
  | { type: "ul"; items: InlineNode[][] }
  | { type: "ol"; items: InlineNode[][] };

type InlineNode =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "italic"; text: string }
  | { type: "bold_italic"; text: string }
  | { type: "code"; text: string };

function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  const pattern = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push({ type: "text", text: text.slice(lastIndex, match.index) });
    }
    if (match[2]) {
      nodes.push({ type: "bold_italic", text: match[2] });
    } else if (match[3]) {
      nodes.push({ type: "bold", text: match[3] });
    } else if (match[4]) {
      nodes.push({ type: "italic", text: match[4] });
    } else if (match[5]) {
      nodes.push({ type: "code", text: match[5] });
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    nodes.push({ type: "text", text: text.slice(lastIndex) });
  }

  return nodes.length > 0 ? nodes : [{ type: "text", text }];
}

function parseBlocks(markdown: string): Token[] {
  const lines = markdown.split("\n");
  const tokens: Token[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code blocks
    if (line.trimStart().startsWith("```")) {
      const lang = line.trimStart().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      tokens.push({ type: "code_block", lang, code: codeLines.join("\n") });
      i++;
      continue;
    }

    // Headers
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3;
      tokens.push({ type: "heading", level, children: parseInline(headingMatch[2]) });
      i++;
      continue;
    }

    // Unordered list
    if (/^[\s]*[-*]\s+/.test(line)) {
      const items: InlineNode[][] = [];
      while (i < lines.length && /^[\s]*[-*]\s+/.test(lines[i])) {
        items.push(parseInline(lines[i].replace(/^[\s]*[-*]\s+/, "")));
        i++;
      }
      tokens.push({ type: "ul", items });
      continue;
    }

    // Ordered list
    if (/^[\s]*\d+[.)]\s+/.test(line)) {
      const items: InlineNode[][] = [];
      while (i < lines.length && /^[\s]*\d+[.)]\s+/.test(lines[i])) {
        items.push(parseInline(lines[i].replace(/^[\s]*\d+[.)]\s+/, "")));
        i++;
      }
      tokens.push({ type: "ol", items });
      continue;
    }

    // Empty line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph: collect consecutive non-empty, non-special lines
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].trimStart().startsWith("```") &&
      !lines[i].match(/^#{1,3}\s+/) &&
      !/^[\s]*[-*]\s+/.test(lines[i]) &&
      !/^[\s]*\d+[.)]\s+/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      tokens.push({ type: "paragraph", children: parseInline(paraLines.join(" ")) });
    }
  }

  return tokens;
}

function renderInline(nodes: InlineNode[]): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.type) {
      case "text":
        return <span key={i}>{node.text}</span>;
      case "bold":
        return <strong key={i} className="font-bold">{node.text}</strong>;
      case "italic":
        return <em key={i}>{node.text}</em>;
      case "bold_italic":
        return <strong key={i} className="font-bold italic">{node.text}</strong>;
      case "code":
        return (
          <code
            key={i}
            className="rounded-[5px] bg-black/[0.06] px-1.5 py-0.5 font-mono text-[0.85em]"
          >
            {node.text}
          </code>
        );
    }
  });
}

export function ChatMarkdown({ content }: { content: string }) {
  const tokens = useMemo(() => parseBlocks(content), [content]);

  return (
    <div className="chat-markdown space-y-2.5 text-sm leading-[1.7]">
      {tokens.map((token, i) => {
        switch (token.type) {
          case "paragraph":
            return <p key={i}>{renderInline(token.children)}</p>;
          case "heading": {
            const Tag = `h${token.level}` as "h1" | "h2" | "h3";
            const sizes = { 1: "text-lg", 2: "text-base", 3: "text-sm" } as const;
            return (
              <Tag key={i} className={`${sizes[token.level]} mt-3 font-bold tracking-[-0.02em]`}>
                {renderInline(token.children)}
              </Tag>
            );
          }
          case "code_block":
            return (
              <div key={i} className="overflow-x-auto rounded-xl bg-[#1e1e1e] text-[#d4d4d4]">
                {token.lang ? (
                  <div className="border-b border-white/10 px-4 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-white/40">
                    {token.lang}
                  </div>
                ) : null}
                <pre className="overflow-x-auto p-4 text-[13px] leading-[1.6]">
                  <code>{token.code}</code>
                </pre>
              </div>
            );
          case "ul":
            return (
              <ul key={i} className="list-inside list-disc space-y-1 pl-1">
                {token.items.map((item, j) => (
                  <li key={j} className="text-sm">{renderInline(item)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i} className="list-inside list-decimal space-y-1 pl-1">
                {token.items.map((item, j) => (
                  <li key={j} className="text-sm">{renderInline(item)}</li>
                ))}
              </ol>
            );
        }
      })}
    </div>
  );
}
