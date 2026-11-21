// 将本地截图压缩到单条内核消息的容量内。制作人：Moriarty_Dox
export async function prepareImage(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 16 * 1024 * 1024) throw new Error('请选择 16 MiB 以内的 PNG、JPEG 或 WebP 图片。')
  const bitmap = await createImageBitmap(file)
  try {
    const canvas = document.createElement('canvas')
    let scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
    for (let attempt = 0; attempt < 4; attempt++) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      const result = canvas.toDataURL('image/jpeg', 0.86)
      if (result.startsWith('data:image/jpeg;') && result.length <= 720000) return result
      scale *= 0.7
    }
    throw new Error('图片仍然过大，请裁剪后重试。')
  } finally { bitmap.close() }
}
