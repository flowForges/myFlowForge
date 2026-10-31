// 停机预算:监管发 drain 后 WORKER_KILL_MS 强杀工作进程;工作进程先排空 DRAIN_MS,
// 再 close()(中止进行中的 turn,最多等 CLOSE_GRACE_MS 让 shell 杀完进程组、终态写进库),留 CLOSE_MARGIN_MS 关库退出

/** 监管:drain 之后多久 SIGKILL 工作进程 */
export const WORKER_KILL_MS = 30_000
/** kernel.close():中止 turn 后等它们收尾的上限(shell:SIGTERM,2 s 后 SIGKILL,再 1 s 不等管道) */
export const CLOSE_GRACE_MS = 3_500
/** close 之后关库、关 socket、退出的余量 */
export const CLOSE_MARGIN_MS = 1_500
/** 工作进程:收到 drain 后等进行中的 turn 自然结束的上限 */
export const DRAIN_MS = WORKER_KILL_MS - CLOSE_GRACE_MS - CLOSE_MARGIN_MS
