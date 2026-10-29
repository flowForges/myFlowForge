// 副作用作用域:收集清理函数,按相反顺序统一释放
export class EffectScope {
  private disposers: Array<() => void | Promise<void>> = []

  add(dispose: () => void | Promise<void>): void {
    this.disposers.push(dispose)
  }

  async disposeAll(): Promise<void> {
    const list = this.disposers.reverse()
    this.disposers = []
    const errors: unknown[] = []
    for (const d of list) {
      try {
        await d()
      } catch (e) {
        errors.push(e)
      }
    }
    if (errors.length) throw new AggregateError(errors, 'effect dispose failed')
  }
}
