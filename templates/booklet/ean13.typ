// An EAN-13 barcode, which is what an ISBN-13 is printed as. Drawn from the
// GS1 general specifications: 95 modules of 0.33 mm at the nominal size, the
// guard bars reaching down into the human readable digits, a quiet zone of 11
// modules on the left and 7 on the right.

// the left half's digits alternate between the L and G codes as the first
// digit says, the right half always uses the R codes
#let parities = (
  "LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG",
  "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL",
)
#let l-codes = (
  "0001101", "0011001", "0010011", "0111101", "0100011",
  "0110001", "0101111", "0111011", "0110111", "0001011",
)
#let invert(code) = code.clusters().map(bit => if bit == "1" { "0" } else { "1" }).join()
#let g-code(digit) = invert(l-codes.at(digit)).clusters().rev().join()
#let r-code(digit) = invert(l-codes.at(digit))

/// The modules of a 13 digit code as a string of 0s and 1s, 95 long
#let ean13-modules(digits) = {
  let first = digits.at(0)
  let parity = parities.at(first).clusters()
  let left = range(1, 7).map(i => if parity.at(i - 1) == "L" { l-codes.at(digits.at(i)) } else { g-code(digits.at(i)) })
  let right = range(7, 13).map(i => r-code(digits.at(i)))
  "101" + left.join() + "01010" + right.join() + "101"
}

/// Draws the barcode of a 13 digit string, checksum included, with its digits
/// underneath. `module` is the width of one bar, 0.33mm at 100% size.
#let ean13(code, module: 0.33mm, height: 22.85mm, fg: black) = {
  let digits = code.clusters().map(int)
  assert(digits.len() == 13, message: "an EAN-13 code has 13 digits")
  let modules = ean13-modules(digits).clusters()
  let guard-extra = 5 * module
  let digit-size = 8 * module
  // the guard bars: the start, centre and end patterns
  let guards = range(0, 3) + range(45, 50) + range(92, 95)

  set text(font: "PT Sans", size: digit-size, fill: fg)
  let width = (11 + 95 + 7) * module
  box(width: width, height: height + digit-size, {
    for (i, bit) in modules.enumerate() {
      if bit == "1" {
        let tall = i in guards
        place(top + left, dx: (11 + i) * module, rect(
          width: module,
          height: height + if tall { guard-extra } else { 0mm },
          fill: fg,
          stroke: none,
        ))
      }
    }
    // the first digit sits in the left quiet zone, six under each half
    place(top + left, dx: 2 * module, dy: height, str(digits.at(0)))
    for i in range(1, 7) {
      place(top + left, dx: (11 + 3 + (i - 1) * 7) * module, dy: height, box(width: 7 * module, align(center, str(digits.at(i)))))
    }
    for i in range(7, 13) {
      place(top + left, dx: (11 + 50 + (i - 7) * 7) * module, dy: height, box(width: 7 * module, align(center, str(digits.at(i)))))
    }
  })
}
