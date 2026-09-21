// A printable list of a discipline's tricks. Everything it typesets comes from
// `data.json`, which the API writes next to this file, see
// `src/services/booklet.ts` for its shape.

#let data = json("data.json")
#let s = data.strings

#set document(title: data.title + " – " + data.discipline, author: "the Tricktionary")

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
// a level starts a new page, its heading spans the page's columns
#show heading.where(level: 1): it => {
  pagebreak(weak: true)
  set text(size: 1.8em)
  place(top + center, scope: "parent", float: true, block(below: 0.6em, it))
}
#show heading.where(level: 2): it => {
  set text(size: 1.3em)
  block(above: 1.4em, below: 0.7em, it)
}

// ---------- Cover ----------

#page(numbering: none, columns: 1)[
  #align(center + horizon)[
    #text(size: 3.2em, weight: "bold")[#data.title]

    #v(0.5em)
    #text(size: 1.8em)[#data.discipline]
  ]

  #align(bottom)[
    #set text(size: 0.9em)
    #s.info

    #if s.verified != none [
      #sym.checkmark #s.verified
    ]

    #text(fill: luma(40%))[#s.generated]
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
// page count up to a multiple of `padToMultipleOf`, so that an imposed booklet
// never needs blank pages.

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
  let last = first + data.speed.pages - 1
  let padding = calc.rem(data.padToMultipleOf - calc.rem(last, data.padToMultipleOf), data.padToMultipleOf)
  for _ in range(data.speed.pages + padding) {
    speed-page
  }
}
