import { PDFDocument } from '@cantoo/pdf-lib'

const PT_PER_MM = 72 / 25.4

export interface SheetSize {
  /** in mm, twice the width of a page of the document being imposed */
  width: number
  /** in mm */
  height: number
}

/**
 * Lays the pages of a document out two per side of a landscape sheet in
 * saddle-stitch order, so that the printed sheets folded down the middle and
 * stacked make a booklet. The page count is padded to a multiple of four with
 * blank pages. Sheets are meant to be printed double-sided, flipped on the
 * short edge: the back of the sheet with pages n and 1 on it has 2 and n-1.
 */
export async function imposeBooklet (pdf: Uint8Array, sheet: SheetSize): Promise<Uint8Array> {
  const source = await PDFDocument.load(pdf)
  const sourcePages = source.getPageCount()
  const total = Math.ceil(sourcePages / 4) * 4

  const output = await PDFDocument.create()
  output.setTitle(source.getTitle() ?? '')
  output.setAuthor(source.getAuthor() ?? '')
  output.setLanguage(source.getLanguage() ?? '')

  const embedded = await output.embedPdf(source, [...Array(sourcePages).keys()])

  const sheetWidth = sheet.width * PT_PER_MM
  const sheetHeight = sheet.height * PT_PER_MM
  const pageWidth = sheetWidth / 2

  for (let side = 0; side < total / 2; side++) {
    const outer = total - side
    const inner = side + 1
    // the front of a sheet has the higher page number on the left, its back has it on the right
    const [left, right] = side % 2 === 0 ? [outer, inner] : [inner, outer]

    const page = output.addPage([sheetWidth, sheetHeight])
    for (const [pageNumber, x] of [[left, 0], [right, pageWidth]] as const) {
      const embeddedPage = embedded[pageNumber - 1]
      if (!embeddedPage) continue // a padding page
      page.drawPage(embeddedPage, { x, y: 0, width: pageWidth, height: sheetHeight })
    }
  }

  return await output.save()
}
