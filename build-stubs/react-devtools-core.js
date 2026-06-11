// react-devtools-core 的空替身（stub）。
// ink 仅在环境变量 DEV=true 时才会动态加载 devtools 并调用 connectToDevTools()，
// DCODE 生产运行不需要它。为避免把这个庞大且非必需的依赖打进包里，
// 在构建时用本 stub 通过 esbuild alias 替换它，提供一个无副作用的同名实现。
// 制作人：Moriarty_Dox

// 默认导出一个对象，connectToDevTools 为空操作。
export default {
  connectToDevTools() {
    // 故意留空：生产环境不连接 React DevTools。
  },
}
