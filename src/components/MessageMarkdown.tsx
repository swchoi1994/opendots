import Markdown, { type Components } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'

/**
 * Renders a bot reply as structured text. The models answer in Markdown —
 * headings, bullet lists, bold labels, code, the odd table — and a plain
 * `{text}` collapsed all of that into one grey paragraph. Raw HTML from the
 * model is never rendered (react-markdown escapes it), links open in a new
 * tab, and headings are sized for a chat bubble rather than a document.
 */
const components: Components = {
  h1: ({ children }) => <h1 className="mt-3 mb-1 text-[16px] font-semibold text-ink-900 first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-3 mb-1 text-[15px] font-semibold text-ink-900 first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-2.5 mb-1 text-[14px] font-semibold text-ink-900 first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-2 mb-0.5 text-[14px] font-semibold text-ink-700 first:mt-0">{children}</h4>,
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-1.5 list-disc space-y-1 pl-5 marker:text-ink-400">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-1 pl-5 marker:text-ink-500">{children}</ol>,
  li: ({ children }) => <li className="[&>p]:my-0">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-ink-900">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-brand-700 underline decoration-brand-500/40 underline-offset-2 hover:decoration-brand-700"
    >
      {children}
    </a>
  ),
  code: ({ children }) => (
    <code className="rounded-md bg-black/[0.06] px-1.5 py-0.5 font-mono text-[13px] text-ink-900">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-xl bg-ink-900 p-3 font-mono text-[13px] leading-relaxed text-white [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-inherit">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-brand-500/50 pl-3 text-ink-700 [&>p]:my-0">{children}</blockquote>
  ),
  hr: () => <hr className="my-3 border-line" />,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="text-left text-ink-700">{children}</thead>,
  th: ({ children }) => <th className="border-b border-line px-2 py-1 font-semibold">{children}</th>,
  td: ({ children }) => <td className="border-b border-line/60 px-2 py-1 align-top">{children}</td>,
}

export function MessageMarkdown({ text }: { text: string }) {
  return (
    <div className="message-markdown break-words">
      <Markdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
        {text}
      </Markdown>
    </div>
  )
}
