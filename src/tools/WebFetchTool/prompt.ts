export const WEB_FETCH_TOOL_NAME = 'WebFetch'

/**
 * AI Cursor — search-engine result pages are hostile to fetch (captcha,
 * redirects, timeouts). Models must use WebSearch for discovery instead.
 */
export function isSearchEngineResultsUrl(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  const path = u.pathname.toLowerCase()
  const q = u.search.toLowerCase()

  // Explicit search endpoints
  if (
    (host === 'google.com' || host.endsWith('.google.com')) &&
    (path.startsWith('/search') || path === '/url' || path.startsWith('/webhp'))
  )
    return true
  if (
    (host === 'bing.com' || host.endsWith('.bing.com')) &&
    (path.startsWith('/search') || path.startsWith('/images/search'))
  )
    return true
  if (
    (host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com')) &&
    (path.includes('/html') || path.startsWith('/?') || (path === '/' && q.includes('q=')))
  )
    return true
  if (host === 'search.yahoo.com' || host.endsWith('.search.yahoo.com'))
    return true
  if (
    (host === 'yandex.com' || host === 'yandex.ru' || host.endsWith('.yandex.com')) &&
    (path.startsWith('/search') || q.includes('text='))
  )
    return true
  if (
    (host === 'baidu.com' || host.endsWith('.baidu.com')) &&
    (path.startsWith('/s') || q.includes('wd='))
  )
    return true
  if (
    (host === 'sogou.com' || host.endsWith('.sogou.com')) &&
    (path.includes('web') || q.includes('query='))
  )
    return true

  return false
}

export const DESCRIPTION = `
- Fetches content from a specified URL and processes it using an AI model
- Takes a URL and a prompt as input
- Fetches the URL content, converts HTML to markdown
- Processes the content with the prompt using a small, fast model
- Returns the model's response about the content
- Use this tool when you need to retrieve and analyze web content

Usage notes:
  - IMPORTANT: Do NOT use WebFetch on search-engine result pages (Google / Bing / DuckDuckGo / Baidu / Yahoo / Yandex search URLs). Those pages timeout, redirect, or return captchas. To search the web, call WebSearch with a query; then WebFetch only concrete article/product/wiki URLs from the results.
  - IMPORTANT: If an MCP-provided web fetch tool is available, prefer using that tool instead of this one, as it may have fewer restrictions.
  - The URL must be a fully-formed valid URL
  - HTTP URLs will be automatically upgraded to HTTPS
  - The prompt should describe what information you want to extract from the page
  - This tool is read-only and does not modify any files
  - Results may be summarized if the content is very large
  - Includes a self-cleaning 15-minute cache for faster responses when repeatedly accessing the same URL
  - When a URL redirects to a different host, the tool will inform you and provide the redirect URL in a special format. You should then make a new WebFetch request with the redirect URL to fetch the content.
  - For GitHub URLs, prefer using the gh CLI via Bash instead (e.g., gh pr view, gh issue view, gh api).
`

export function makeSecondaryModelPrompt(
  markdownContent: string,
  prompt: string,
  isPreapprovedDomain: boolean,
): string {
  const guidelines = isPreapprovedDomain
    ? `Provide a concise response based on the content above. Include relevant details, code examples, and documentation excerpts as needed.`
    : `Provide a concise response based only on the content above. In your response:
 - Enforce a strict 125-character maximum for quotes from any source document. Open Source Software is ok as long as we respect the license.
 - Use quotation marks for exact language from articles; any language outside of the quotation should never be word-for-word the same.
 - You are not a lawyer and never comment on the legality of your own prompts and responses.
 - Never produce or reproduce exact song lyrics.`

  return `
Web page content:
---
${markdownContent}
---

${prompt}

${guidelines}
`
}
