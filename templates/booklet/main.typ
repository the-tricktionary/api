// A printable list of a discipline's tricks. Everything it typesets comes from
// `data.json`, which the API writes next to this file, see
// `src/services/booklet.ts` for its shape.

#import "ean13.typ": ean13

#let data = json("data.json")
#let s = data.strings
#let print = data.print
#let brand-red = rgb("#fe3500")

#set document(title: data.title + " – " + data.discipline, author: "the Tricktionary")

#set page(
  width: data.page.width * 1mm,
  height: data.page.height * 1mm,
  margin: data.page.margin * 1mm,
  // print shops trim the bleed off, the PDF carries the trim box
  bleed: data.page.bleed * 1mm,
  numbering: "1",
)
#set text(
  font: "PT Sans",
  size: data.page.fontSize * 1pt,
  lang: data.lang,
  ..if data.region != none { (region: data.region) },
)
#set par(justify: false)

#set heading(numbering: none)
// a level starts a new page, its heading spans the page's columns; a heading
// labelled <in-place> stays where it is, for a page laid out by hand
#show heading.where(level: 1): it => {
  set text(size: 1.8em)
  if it.has("label") and it.label == <in-place> {
    block(below: 0.5em, it)
  } else {
    pagebreak(weak: true)
    place(top + center, scope: "parent", float: true, block(below: 0.6em, it))
  }
}
#show heading.where(level: 2): it => {
  set text(size: 1.3em)
  block(above: 1.4em, below: 0.7em, it)
}

// ---------- Cover ----------

#let cover-title = [
  #text(size: 3.2em, weight: "bold")[#data.title]

  #v(0.5em)
  #text(size: 1.8em)[#data.discipline]
]

#let cover-notes = [
  #set text(size: 0.9em)
  #s.info

  #if s.verified != none [
    #sym.checkmark #s.verified
  ]
]

#if print == none [
  #page(numbering: none, columns: 1)[
    #align(center + horizon, cover-title)

    #align(bottom)[
      #cover-notes

      #text(fill: luma(40%))[#s.generated]
    ]
  ]
] else [
  // the print edition gets the brand red cover, the logo, and a colophon on
  // the inside of the cover
  #page(fill: brand-red, numbering: none, columns: 1)[
    #set text(fill: white)
    #align(center + horizon)[
      #image("logo.svg", width: 45%)

      #v(1em)
      #cover-title
    ]
  ]
  #page(fill: brand-red, numbering: none, columns: 1)[
    #set text(fill: white)
    #align(bottom)[
      #cover-notes

      #set text(size: 0.8em)
      #print.copyright \
      #print.website \
      #print.contact
      #if print.isbnLabel != none [ \ #print.isbnLabel ]
      #if print.printedBy != none [ \ #print.printedBy ]
    ]
  ]
]

// ---------- Tricks ----------

#let checkbox = box(
  width: 0.9em,
  height: 0.9em,
  stroke: 0.6pt + black,
  radius: 1pt,
  baseline: 0.05em,
)

#let trick-item(trick) = block(breakable: false, below: 0.7em)[
  #grid(
    columns: (auto, 1fr),
    column-gutter: 0.5em,
    checkbox,
    [
      #text(weight: "bold", lang: trick.nameLang)[#trick.name]
      #if trick.alternativeNames != none [
        \ #text(style: "italic", size: 0.9em, lang: trick.nameLang)[#trick.alternativeNames]
      ]
      #if trick.description != none [
        \ #text(lang: trick.descriptionLang)[#trick.description]
      ]
      #if trick.level != none [
        \ #text(size: 0.9em)[#trick.level.label #if trick.level.verified [#sym.checkmark]]
      ]
    ]
  )
]

#set page(columns: data.page.columns)

#for group in data.groups [
  #heading(level: 1, group.title)
  #for type in group.types [
    #heading(level: 2, type.title)
    #for trick in type.tricks {
      trick-item(trick)
    }
  ]
]

// ---------- Speed log ----------

// The speed log fills the last pages, and any extra pages needed to bring the
// page count, with the pages that follow the speed log, up to a multiple of
// `padToMultipleOf`, so that an imposed booklet never needs blank pages.

#set page(columns: 1)

// The table fills what is left of the page below the heading, its rows share
// that space, so a page never overflows whatever the paper size
#let speed-page = [
  #heading(level: 1)[#s.speedEvent: #box(width: 40%, stroke: (bottom: 0.6pt + black))]
  #block(height: 1fr, width: 100%, table(
    columns: (1fr, 1fr),
    rows: (auto,) + (1fr,) * data.speed.rows,
    align: left + horizon,
    stroke: 0.5pt + black,
    inset: (x: 0.6em, y: 0.4em),
    [*#s.date*], [*#s.count*],
    ..range(data.speed.rows * 2).map(_ => []),
  ))
]

#pagebreak(weak: true)
#context {
  // the page this lands on is the first speed-log page
  let first = counter(page).get().first()
  let last = first + data.speed.pages - 1 + data.trailingPages
  let padding = calc.rem(data.padToMultipleOf - calc.rem(last, data.padToMultipleOf), data.padToMultipleOf)
  for _ in range(data.speed.pages + padding) {
    speed-page
  }
}

// ---------- Trick map ----------

// A spread: the graph is scaled to fit two pages side by side, each page shows
// its half. It follows the speed log on an even page, so the two face each
// other in the bound booklet.

#if data.map != none [
  #import "@preview/diagraph:0.3.7": render

  #let header-height = 20mm
  #let content-width = (data.page.width - 2 * data.page.margin) * 1mm
  #let content-height = (data.page.height - 2 * data.page.margin) * 1mm
  // a little under what is left, so that rounding never pushes it to a new page
  #let graph-height = content-height - header-height - 2mm
  #let graph = render(data.map.dot, engine: "dot")

  // the graph, fitted to the spread and centred on it, shifted by `dx`
  #let graph-half(dx) = block(width: 100%, height: graph-height, clip: true, context {
    let size = measure(graph)
    let factor = calc.min(2 * content-width / size.width, graph-height / size.height)
    let fitted = scale(factor * 100%, reflow: true, graph)
    let fitted-size = measure(fitted)
    place(
      top + left,
      dx: dx + (2 * content-width - fitted-size.width) / 2,
      dy: (graph-height - fitted-size.height) / 2,
      fitted,
    )
  })

  #let legend = data.map.legend.map(entry => box[
    #box(width: 0.8em, height: 0.8em, radius: 50%, fill: rgb(entry.colour), baseline: 0.1em)
    #entry.label
  ]).join(h(1em))

  #page(columns: 1)[
    #set block(spacing: 0pt)
    #block(height: header-height, width: 100%)[
      #heading(level: 1, data.map.title) <in-place>
      #text(size: 0.9em)[#data.map.explanation]
    ]
    #graph-half(0mm)
  ]
  #page(columns: 1)[
    #set block(spacing: 0pt)
    #block(height: header-height, width: 100%, align(bottom, legend))
    #graph-half(-content-width)
  ]
]

// ---------- Back cover ----------

#if print != none [
  #page(fill: brand-red, numbering: none, columns: 1)[
    #if print.isbnDigits != none [
      #place(bottom + right, box(fill: white, inset: 3mm, radius: 1mm, ean13(print.isbnDigits)))
    ]
  ]
]
