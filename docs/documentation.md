# 使用指南维护

面向最终用户的正文为 [user-guide.md](user-guide.md)。修改后生成同内容的 [PDF](../output/pdf/OpenListTransfer-使用指南.pdf)：

```powershell
python -m pip install reportlab==4.4.9
python scripts/build-user-guide.py
```

生成脚本使用 Windows 自带的微软雅黑字体，并将使用到的字形嵌入 PDF。也可用 `GUIDE_FONT_REGULAR` 和 `GUIDE_FONT_BOLD` 环境变量指定支持中文的 TTF/TTC 字体路径。

`<!-- pagebreak -->` 用于控制 PDF 章节分页，在 GitHub 阅读时隐藏。脚本支持本文使用的标题、段落、列表、表格和 HTTPS 链接。输出后应渲染检查全部页面，确保中文、分页和表格没有截断，再同步提交 Markdown 与 PDF。
