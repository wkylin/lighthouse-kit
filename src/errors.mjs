// 命令行按错误类型给出退出码：配置 2、端口/就绪 3、其余运行失败 1。

export class BuildError extends Error {
  constructor(message, logFile) {
    super(message)
    this.name = 'BuildError'
    this.logFile = logFile
  }
}

export class PortInUseError extends Error {
  constructor(port) {
    super(`端口 ${port} 已被占用：请先关掉占用它的进程，或在配置里换一个端口`)
    this.name = 'PortInUseError'
    this.port = port
  }
}

export class NotReadyError extends Error {
  constructor(message, logFile) {
    super(message)
    this.name = 'NotReadyError'
    this.logFile = logFile
  }
}
