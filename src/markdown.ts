const PH = "\u0000"

function stripFencedBlocks(input: string): { text: string; blocks: string[] } {
  const blocks: string[] = []
  const fenced = /```[^\n]*\n?[\s\S]*?```/g
  const text = input.replace(fenced, (match) => {
    const cleaned = match
      .replace(/^```[^\n]*\n?/, "```")
      .replace(/\s+```\s*$/, "```")
    blocks.push(cleaned)
    return `${PH}CODE${blocks.length - 1}${PH}`
  })
  return { text, blocks }
}

function convertTables(input: string): string {
  const lines = input.split("\n")
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim().startsWith("|")) {
      out.push(line)
      i++
      continue
    }
    const table: string[] = []
    while (i < lines.length && lines[i].trim().startsWith("|")) {
      table.push(lines[i])
      i++
    }
    const separatorRe = /^\s*\|?[\s:|-]+\|?\s*$/
    const rows = table.filter((row) => !separatorRe.test(row))
    for (const row of rows) {
      const cells = row
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim())
        .filter((cell) => cell.length > 0)
      if (cells.length > 0) out.push(`• ${cells.join(" · ")}`)
    }
  }
  return out.join("\n")
}

export function gfmToMrkdwn(input: string): string {
  const { text: protectedText, blocks } = stripFencedBlocks(input)

  let out = convertTables(protectedText)

  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, "<$2>")

  out = out.replace(/^\s*(---+|\*\*\*+)\s*$/gm, "—")

  out = out.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_m, label: string, url: string) => `<${url}|${label.replace(/[*_`]/g, "")}>`,
  )

  out = out.replace(/~~([^~]+)~~/g, "~$1~")

  const bolds: string[] = []
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_m, t: string) => {
    bolds.push(`*${t}*`)
    return `${PH}B${bolds.length - 1}${PH}`
  })

  out = out.replace(/(^|\s)\*([^*\s][^*\n]*?)\*/g, "$1_$2_")

  out = out.replace(/^#{1,6}\s+(.+)$/gm, (_m, heading: string) => `*${heading.trim()}*`)

  bolds.forEach((b, i) => {
    out = out.split(`${PH}B${i}${PH}`).join(b)
  })

  blocks.forEach((block, i) => {
    out = out.split(`${PH}CODE${i}${PH}`).join(block)
  })

  return out
}
