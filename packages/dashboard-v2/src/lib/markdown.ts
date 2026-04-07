/**
 * Lightweight markdown-to-HTML converter for rendering agent assessments.
 * Handles the subset of markdown commonly produced by Organism agents:
 * headers, bold/italic, bullet/numbered lists, code blocks, tables, hr.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Parse a markdown table (header row, separator row, data rows) into HTML */
function parseTable(headerLine: string, rows: string[]): string {
  const parseRow = (line: string): string[] =>
    line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

  const headers = parseRow(headerLine);
  const htmlParts: string[] = ['<div class="md-table-wrap"><table class="md-table">'];

  // thead
  htmlParts.push('<thead><tr>');
  for (const h of headers) {
    htmlParts.push(`<th class="md-th">${inlineFormat(h)}</th>`);
  }
  htmlParts.push('</tr></thead>');

  // tbody
  htmlParts.push('<tbody>');
  for (const row of rows) {
    const cells = parseRow(row);
    htmlParts.push('<tr>');
    for (let j = 0; j < headers.length; j++) {
      htmlParts.push(`<td class="md-td">${inlineFormat(cells[j] ?? '')}</td>`);
    }
    htmlParts.push('</tr>');
  }
  htmlParts.push('</tbody></table></div>');

  return htmlParts.join('');
}

/** Check if a line looks like a markdown table separator: |---|---|---| */
function isTableSeparator(line: string): boolean {
  return /^\|?[\s:]*-{2,}[\s:]*(\|[\s:]*-{2,}[\s:]*)+\|?$/.test(line.trim());
}

export function renderMarkdown(raw: string): string {
  if (!raw) return '';

  // Normalize escaped newlines from JSON
  const text = raw
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '  ')
    .replace(/\\"/g, '"');

  const lines = text.split('\n');
  const html: string[] = [];
  let inCodeBlock = false;
  let codeBuffer: string[] = [];
  let inList = false;
  let listTag = 'ul'; // 'ul' or 'ol'

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code blocks: ```lang ... ```
    if (line.trimStart().startsWith('```')) {
      if (inCodeBlock) {
        html.push(`<pre class="md-pre"><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`);
        codeBuffer = [];
        inCodeBlock = false;
      } else {
        if (inList) { html.push(`</${listTag}>`); inList = false; }
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBuffer.push(line);
      continue;
    }

    // Blank line -- close list if open
    if (line.trim() === '') {
      if (inList) { html.push(`</${listTag}>`); inList = false; }
      html.push('');
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim()) || /^\*\*\*+$/.test(line.trim())) {
      if (inList) { html.push(`</${listTag}>`); inList = false; }
      html.push('<hr class="md-hr" />');
      continue;
    }

    // Table detection: current line has pipes and next line is a separator
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      if (inList) { html.push(`</${listTag}>`); inList = false; }
      const headerLine = line;
      i++; // skip separator
      const dataRows: string[] = [];
      while (i + 1 < lines.length && lines[i + 1].includes('|') && !isTableSeparator(lines[i + 1])) {
        i++;
        dataRows.push(lines[i]);
      }
      html.push(parseTable(headerLine, dataRows));
      continue;
    }

    // Headers
    if (line.startsWith('#### ')) {
      if (inList) { html.push(`</${listTag}>`); inList = false; }
      html.push(`<h4 class="md-h4">${inlineFormat(line.slice(5))}</h4>`);
      continue;
    }
    if (line.startsWith('### ')) {
      if (inList) { html.push(`</${listTag}>`); inList = false; }
      html.push(`<h3 class="md-h3">${inlineFormat(line.slice(4))}</h3>`);
      continue;
    }
    if (line.startsWith('## ')) {
      if (inList) { html.push(`</${listTag}>`); inList = false; }
      html.push(`<h2 class="md-h2">${inlineFormat(line.slice(3))}</h2>`);
      continue;
    }
    if (line.startsWith('# ')) {
      if (inList) { html.push(`</${listTag}>`); inList = false; }
      html.push(`<h1 class="md-h1">${inlineFormat(line.slice(2))}</h1>`);
      continue;
    }

    // Numbered list items: 1. item, 2. item etc.
    const numberedMatch = line.match(/^(\s*)\d+\.\s+(.*)/);
    if (numberedMatch) {
      if (!inList || listTag !== 'ol') {
        if (inList) html.push(`</${listTag}>`);
        html.push('<ol class="md-ol">');
        inList = true;
        listTag = 'ol';
      }
      html.push(`<li class="md-li">${inlineFormat(numberedMatch[2])}</li>`);
      continue;
    }

    // Bullet list items: - item, * item
    const bulletMatch = line.match(/^(\s*)([-*])\s+(.*)/);
    if (bulletMatch) {
      if (!inList || listTag !== 'ul') {
        if (inList) html.push(`</${listTag}>`);
        html.push('<ul class="md-ul">');
        inList = true;
        listTag = 'ul';
      }
      html.push(`<li class="md-li">${inlineFormat(bulletMatch[3])}</li>`);
      continue;
    }

    // Regular paragraph
    if (inList) { html.push(`</${listTag}>`); inList = false; }
    html.push(`<p class="md-p">${inlineFormat(line)}</p>`);
  }

  // Close any open blocks
  if (inCodeBlock && codeBuffer.length > 0) {
    html.push(`<pre class="md-pre"><code>${escapeHtml(codeBuffer.join('\n'))}</code></pre>`);
  }
  if (inList) html.push(`</${listTag}>`);

  return html.join('\n');
}

/** Apply inline formatting: bold, italic, code, links */
function inlineFormat(text: string): string {
  let result = escapeHtml(text);

  // Inline code (must be before bold/italic to avoid conflicts)
  result = result.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');

  // Bold + italic
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');

  // Bold
  result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Italic
  result = result.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Links [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="md-link" target="_blank" rel="noopener">$1</a>');

  return result;
}
