// A printable list of a discipline's tricks. Everything it typesets comes from
// `data.json`, which the API writes next to this file, see
// `src/services/booklet.ts` for its shape.

#import "ean13.typ": ean13

#let data = json("data.json")
#let s = data.strings
#let print = data.print
#let brand-red = rgb("#fe3500")

#set document(title: data.title + " – " + data.discipline, author: "the Tricktionary")

// for the print layout the page includes its bleed, the API adds it to the
// size and the margins
#set page(
  width: data.page.width * 1mm,
  height: data.page.height * 1mm,
  margin: data.page.margin * 1mm,
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

  #if s.levels != none [
    #s.levels
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
      // the name, and the level in the chosen ruleset right after it
      #text(weight: "bold", lang: trick.nameLang)[#trick.name]
      #if trick.level != none [
        #h(0.5em)
        #text(size: 0.9em, fill: luma(35%))[#trick.level.label#if trick.level.verified [ #sym.checkmark]]
      ]
      #if trick.alternativeNames != none [
        \ #text(style: "italic", size: 0.9em, lang: trick.nameLang)[#trick.alternativeNames]
      ]
      #if trick.description != none [
        \ #text(lang: trick.descriptionLang)[#trick.description]
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

// The inside of the back cover, turned on its side: the graph, laid out by
// Graphviz into `map.svg` next to this file, is scaled to fill the page in
// landscape, with the title and legend along its top, and the whole thing
// rotated so that the top faces the spine.

#if data.map != none [
  // narrower margins than the text pages, the bleed still kept clear
  #let map-margin = (data.page.bleed + 8) * 1mm
  #let inner = (
    width: data.page.height * 1mm - 2 * map-margin,
    height: data.page.width * 1mm - 2 * map-margin,
  )
  #let header-height = 14mm

  // fitted to what is left under the header, the drawn size comes with the
  // data since measuring an image isn't reliable
  #let drawn = (width: data.map.size.width * 1pt, height: data.map.size.height * 1pt)
  #let factor = calc.min(inner.width / drawn.width, (inner.height - header-height) / drawn.height)
  #let fitted = (width: drawn.width * factor, height: drawn.height * factor)

  #let legend = data.map.legend.map(entry => box[
    #box(width: 0.8em, height: 0.8em, radius: 50%, fill: rgb(entry.colour), baseline: 0.1em)
    #entry.label
  ]).join(h(1em))

  #let landscape = block(width: inner.width, height: inner.height)[
    #set block(spacing: 0pt)
    #block(height: header-height, width: 100%, grid(
      columns: (1fr, auto),
      column-gutter: 1em,
      align: (left + top, right + bottom),
      [
        #heading(level: 1, data.map.title) <in-place>
        #text(size: 0.9em)[#data.map.explanation]
      ],
      legend,
    ))
    #block(height: inner.height - header-height, width: 100%, align(center + horizon, image("map.svg", width: fitted.width, height: fitted.height)))
  ]

  #page(margin: map-margin, columns: 1, numbering: none)[
    #place(center + horizon, rotate(-90deg, reflow: true, landscape))
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
