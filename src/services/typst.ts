import { execFile } from 'node:child_process'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TypesettingError, UnavailableError } from '../errors.js'

/**
 * The Typst templates and the fonts they use live next to the code, in
 * `templates/` at the project root, the Dockerfile copies them into the image
 */
export const TEMPLATES_DIR = fileURLToPath(new URL('../../templates/', import.meta.url))
const FONTS_DIR = path.join(TEMPLATES_DIR, 'fonts')
/**
 * Packages from Typst Universe, vendored in the layout of Typst's package
 * cache (`preview/<name>/<version>`) so that nothing is downloaded at runtime
 */
const PACKAGES_DIR = path.join(TEMPLATES_DIR, 'packages')

/** A booklet compiles in well under a second, anything near this is broken */
const COMPILE_TIMEOUT_MS = 30_000
/** A compile is CPU bound, more at once only slow each other down */
const MAX_CONCURRENT = 2
/** Beyond this the instance is overloaded, callers are better off retrying later */
const MAX_QUEUED = 32
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

let running = 0
const waiting: Array<() => void> = []

async function acquire () {
  if (running < MAX_CONCURRENT) {
    running++
    return
  }
  if (waiting.length >= MAX_QUEUED) throw new UnavailableError('Too many documents are being typeset at once, try again shortly')
  await new Promise<void>(resolve => waiting.push(resolve))
  running++
}

function release () {
  running--
  waiting.shift()?.()
}

export interface CompileOptions {
  /** A directory under `templates/`, its `main.typ` is compiled */
  template: string
  /** Written as `data.json` next to the template, which reads it with `json("data.json")` */
  data: unknown
  /** The Typst binary, `TYPST_BIN` in the configuration */
  bin: string
  /** Stamped as the PDF's creation date, so the same data gives the same bytes */
  creationDate?: Date
}

/**
 * Typesets a template into a PDF. The template and its data are copied into a
 * temporary directory that is also the project root, so the template can only
 * read what was put there; fonts are passed separately.
 */
export async function compileTypst ({ template, data, bin, creationDate }: CompileOptions): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'typst-'))
  try {
    await cp(path.join(TEMPLATES_DIR, template), dir, { recursive: true })
    await writeFile(path.join(dir, 'data.json'), JSON.stringify(data))

    await acquire()
    try {
      return await run(bin, [
        'compile',
        '--root', dir,
        '--ignore-system-fonts',
        '--font-path', FONTS_DIR,
        '--package-cache-path', PACKAGES_DIR,
        path.join(dir, 'main.typ'),
        '-'
      ], creationDate)
    } finally {
      release()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function run (bin: string, args: string[], creationDate?: Date): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    execFile(bin, args, {
      encoding: 'buffer',
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: COMPILE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        ...(creationDate ? { SOURCE_DATE_EPOCH: String(Math.floor(creationDate.getTime() / 1000)) } : {})
      }
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new TypesettingError(`Typst failed: ${err.message}`, { cause: err, private: { stderr: stderr.toString('utf8') } }))
        return
      }
      resolve(stdout)
    })
  })
}
