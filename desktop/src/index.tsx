// React 18 渲染入口；所有原生能力只能经 window.dcode 白名单访问。
// 制作人：Moriarty_Dox
import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('Missing root element')
createRoot(root).render(<React.StrictMode><App /></React.StrictMode>)
