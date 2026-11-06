// A real one-page PDF that says `text` in Helvetica, built byte for byte with
// a correct cross-reference table, so pdftotext reads it. For the tests of
// process/pdf-text.ts and tests/web.test.ts.

/** The PDF's bytes. `text` is one line of printable ASCII. */
export const samplePdf = (text: string): Uint8Array => {
  const escaped = text.replace(/[\\()]/g, (char) => `\\${char}`)
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let body = "%PDF-1.4\n"
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(body)
}
