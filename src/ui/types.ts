// UI 展示项类型定义。
// 主界面通过一个 DisplayItem 列表渲染历史内容（用户消息、助手回复、工具调用、系统提示、横幅）。
// 已完成的展示项会进入 ink 的 <Static> 区域，避免重复渲染导致的闪烁。
// 制作人：Moriarty_Dox

// 系统提示的语气，影响配色。
export type SystemTone = 'info' | 'success' | 'error' | 'warning'

// 各类展示项的联合类型；每项带唯一 id 作为 React key。
export type DisplayItem =
  // 顶部欢迎横幅（仅一条，含制作人署名）。
  | { id: string; kind: 'banner'; model: string; cwd: string }
  // 用户输入的一条消息。
  | { id: string; kind: 'user'; text: string }
  // 助手的一条回复（可含思维链）。用于「会话回放」等一次性整条渲染场景。
  | { id: string; kind: 'assistant'; text: string; reasoning?: string }
  // 流式分块：实时流式时把「已完成的整行」逐块落入 Static，使输出像普通命令输出一样
  // 自然流进滚动历史、终端跟随到底部（避免动态区原地重绘导致视口被钉住、不跟随）。
  //   variant: 'reasoning' 为思维链分块（暗色），'text' 为正文分块；
  //   head:    是否为该条助手消息中该类型的「首块」——首块带「● 」/「💭 思考过程：」标签；
  //   text:    分块文本（空串代表正文中的一行空行，渲染为空白行）；
  //   spacer:  是否为「间隔块」——渲染为一行空白，用于分隔思维链/正文/消息。
  | {
      id: string
      kind: 'stream'
      variant: 'reasoning' | 'text'
      text: string
      head: boolean
      spacer?: boolean
    }
  // 一次工具调用的最终结果。
  | {
      id: string
      kind: 'tool'
      name: string
      summary: string
      status: 'done' | 'error'
      resultText: string
    }
  // 系统提示信息（命令输出、错误、状态变更等）。
  | { id: string; kind: 'system'; tone: SystemTone; text: string }
  // 权限请求快照：弹窗出现时把「标题 + 预览」一次性落入 Static 历史，
  // 像普通命令输出一样进入滚动区（完整、可上滑查看）。交互选项则留在动态区，
  // 从而避免「动态区高于视口 + 反复重绘」导致的残影 / 重复绘制（Bug 2）。
  | { id: string; kind: 'permission'; title: string; preview?: string }
