'use strict'
import { Neovim } from '@chemzqm/neovim'
import debounce from 'debounce'
import { CancellationTokenSource, Emitter, Event, Range } from 'vscode-languageserver-protocol'
import languages from '../../languages'
import { SyncItem } from '../../model/bufferSync'
import Document from '../../model/document'
import Regions from '../../model/regions'
import { getLabel, InlayHintWithProvider } from '../../provider/inlayHintManager'
import { positionInRange } from '../../util/position'
import { byteIndex } from '../../util/string'
const logger = require('../../util/logger')('inlayHint-buffer')

export interface InlayHintConfig {
  filetypes: string[]
  srcId?: number
}

const debounceInterval = global.hasOwnProperty('__TEST__') ? 10 : 100
const highlightGroup = 'CocInlayHint'

export default class InlayHintBuffer implements SyncItem {
  private tokenSource: CancellationTokenSource
  private regions = new Regions()
  // Saved for resolve and TextEdits in the future.
  private currentHints: InlayHintWithProvider[] = []
  private readonly _onDidRefresh = new Emitter<void>()
  public readonly onDidRefresh: Event<void> = this._onDidRefresh.event
  public render: Function & { clear(): void }
  constructor(
    private readonly nvim: Neovim,
    public readonly doc: Document,
    private readonly config: InlayHintConfig,
    private isVim: boolean
  ) {
    this.render = debounce(() => {
      void this.renderRange()
    }, debounceInterval)
    this.render()
  }

  public get current(): ReadonlyArray<InlayHintWithProvider> {
    return this.currentHints
  }

  public get enabled(): boolean {
    let { filetypes } = this.config
    if (!filetypes.length) return false
    if (!filetypes.includes('*') && !filetypes.includes(this.doc.filetype)) return false
    return languages.hasProvider('inlayHint', this.doc.textDocument)
  }

  public clearCache(): void {
    this.currentHints = []
    this.regions.clear()
    this.render.clear()
  }

  public onTextChange(): void {
    this.regions.clear()
    this.cancel()
  }

  public onChange(): void {
    this.clearCache()
    this.cancel()
    this.render()
  }

  public cancel(): void {
    this.render.clear()
    if (this.tokenSource) {
      this.tokenSource.cancel()
      this.tokenSource = null
    }
  }

  public async renderRange(): Promise<void> {
    this.cancel()
    if (!this.enabled) return
    this.tokenSource = new CancellationTokenSource()
    let token = this.tokenSource.token
    let res = await this.nvim.call('coc#window#visible_range', [this.doc.bufnr]) as [number, number]
    if (res == null || this.doc.dirty || token.isCancellationRequested) return
    if (this.regions.has(res[0], res[1])) return
    let range = Range.create(res[0] - 1, 0, res[1], 0)
    let inlayHints = await languages.provideInlayHints(this.doc.textDocument, range, token)
    if (inlayHints == null || token.isCancellationRequested) return
    // Since no click available, no need to resolve.
    this.regions.add(res[0], res[1])
    this.currentHints = this.currentHints.filter(o => positionInRange(o.position, range) !== 0)
    this.currentHints.push(...inlayHints)
    this.setVirtualText(range, inlayHints, this.isVim)
  }

  public setVirtualText(range: Range, inlayHints: InlayHintWithProvider[], isVim: boolean): void {
    let { nvim, doc } = this
    let srcId = this.config.srcId
    let buffer = doc.buffer
    const chunksMap = {}
    if (!isVim) {
      for (const item of inlayHints) {
        const chunks: [[string, string]] = [[getLabel(item), highlightGroup]]
        if (chunksMap[item.position.line] === undefined) {
          chunksMap[item.position.line] = chunks
        } else {
          chunksMap[item.position.line].push([' ', 'Normal'])
          chunksMap[item.position.line].push(chunks[0])
        }
      }
    }
    nvim.pauseNotification()
    buffer.clearNamespace(srcId, range.start.line, range.end.line + 1)
    if (isVim) {
      for (const item of inlayHints) {
        const chunks: [string, string][] = []
        let { position } = item
        let line = this.doc.getline(position.line)
        let col = byteIndex(line, position.character) + 1
        if (item.paddingLeft) {
          chunks.push([' ', 'Normal'])
        }
        chunks.push([getLabel(item), highlightGroup])
        if (item.paddingRight) {
          chunks.push([' ', 'Normal'])
        }
        buffer.setVirtualText(srcId, position.line, chunks, { col })
      }
    } else {
      for (let key of Object.keys(chunksMap)) {
        buffer.setExtMark(srcId, Number(key), 0, {
          virt_text: chunksMap[key],
          virt_text_pos: 'eol',
          hl_mode: 'combine'
        })
      }
    }
    nvim.resumeNotification(true, true)
    this._onDidRefresh.fire()
  }

  public clearVirtualText(): void {
    let srcId = this.config.srcId
    this.doc.buffer.clearNamespace(srcId)
  }

  public dispose(): void {
    this.cancel()
  }
}
