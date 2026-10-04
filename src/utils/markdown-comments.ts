import { escapeHtml } from "@/utils/html";

/** Render Obsidian comments as visible secondary text in the outline. */
export function renderMarkdownComments(text: string | undefined) {
    return (text || "").replace(/%%([\s\S]*?)%%/g, (_match, content: string) => {
        return `<span class="cm-comment">${escapeHtml(content)}</span>`;
    });
}

/** Keep comment content searchable while omitting its source delimiters. */
export function markdownCommentsToText(text: string | undefined) {
    return (text || "").replace(/%%([\s\S]*?)%%/g, "$1");
}
