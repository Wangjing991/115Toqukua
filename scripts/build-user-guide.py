"""Render docs/user-guide.md as a PDF with embedded Windows Chinese fonts.

Requires Python 3 and reportlab: python -m pip install reportlab
Run: python scripts/build-user-guide.py
Font overrides: GUIDE_FONT_REGULAR and GUIDE_FONT_BOLD (TTF/TTC paths).
The small Markdown subset intentionally rejects unsupported block markup.
"""

import os
import json
import re
from html import escape
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
)

ROOT = Path(__file__).resolve().parent.parent
VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
SOURCE = ROOT / "docs" / "user-guide.md"
OUTPUT = ROOT / "output" / "pdf" / "OpenListTransfer-使用指南.pdf"
INK = colors.HexColor("#203047")
MUTED = colors.HexColor("#596A80")
GREEN = colors.HexColor("#087F70")
PALE = colors.HexColor("#EEF7F5")
RULE = colors.HexColor("#D9E5E8")
WIDTH = A4[0] - 84


def register_fonts():
    for name, env, fallback in [
        ("Guide", "GUIDE_FONT_REGULAR", "C:/Windows/Fonts/msyh.ttc"),
        ("GuideBold", "GUIDE_FONT_BOLD", "C:/Windows/Fonts/msyhbd.ttc"),
    ]:
        filename = Path(os.environ.get(env, fallback))
        if not filename.is_file():
            raise SystemExit(f"Chinese font missing: set {env} to a TTF/TTC file")
        pdfmetrics.registerFont(TTFont(name, str(filename), subfontIndex=0))
    pdfmetrics.registerFontFamily("Guide", normal="Guide", bold="GuideBold")


def inline(text):
    # Escape source before adding ReportLab markup; never interpret raw HTML.
    text = escape(text)
    text = re.sub(r"\[([^\]]+)\]\((https://[^\s)]+)\)",
                  r'<link href="\2" color="#087F70"><u>\1</u></link>', text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", text)
    return re.sub(r"`([^`]+)`", r'<font color="#087F70">\1</font>', text)


def styles():
    base = dict(fontName="Guide", fontSize=9.6, leading=15.2,
                textColor=INK, wordWrap="CJK", alignment=TA_LEFT)
    return {
        "body": ParagraphStyle("body", **base, spaceAfter=6),
        "list": ParagraphStyle("list", **base, leftIndent=11, firstLineIndent=-11, spaceAfter=3),
        "title": ParagraphStyle("title", fontName="GuideBold", fontSize=25,
                                leading=33, textColor=GREEN, spaceAfter=12),
        "section": ParagraphStyle("section", fontName="GuideBold", fontSize=17,
                                  leading=23, textColor=GREEN, spaceAfter=12,
                                  keepWithNext=True),
        "sub": ParagraphStyle("sub", fontName="GuideBold", fontSize=11.4,
                              leading=17, textColor=INK, spaceBefore=6,
                              spaceAfter=5, keepWithNext=True),
        "cell": ParagraphStyle("cell", **{**base, "fontSize": 9.1, "leading": 14}),
        "meta": ParagraphStyle("meta", **{**base, "fontSize": 8.1, "leading": 12,
                                           "textColor": MUTED}, spaceAfter=3),
    }


def make_table(lines, sty):
    parsed = [[cell.strip() for cell in line.strip().strip("|").split("|")]
              for line in lines]
    if len(parsed) < 2 or not all(re.fullmatch(r":?-+:?", c) for c in parsed[1]):
        raise ValueError("Malformed Markdown table")
    rows = [parsed[0], *parsed[2:]]
    count = len(rows[0])
    if any(len(row) != count for row in rows):
        raise ValueError("Inconsistent table columns")
    widths = [WIDTH * .31, WIDTH * .69] if count == 2 else [WIDTH * .29, WIDTH * .21, WIDTH * .50]
    if count not in (2, 3):
        raise ValueError("Only two or three column tables are supported")
    data = [[Paragraph(('<b>' + inline(c) + '</b>') if n == 0 else inline(c), sty["cell"])
             for c in row] for n, row in enumerate(rows)]
    table = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), PALE),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F7F9FB")]),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("LINEBELOW", (0, 0), (-1, 0), .6, RULE),
        ("LINEBELOW", (0, 1), (-1, -1), .3, RULE),
    ]))
    table.spaceAfter = 9
    return table


def parse(markdown, sty):
    lines = markdown.splitlines()
    story = []
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        i += 1
        if not line:
            continue
        if line == "<!-- pagebreak -->":
            story.append(PageBreak())
        elif line.startswith("|"):
            table_lines = [line]
            while i < len(lines) and lines[i].lstrip().startswith("|"):
                table_lines.append(lines[i])
                i += 1
            story.append(make_table(table_lines, sty))
        elif line.startswith("# "):
            story.append(Paragraph(inline(line[2:]), sty["title"]))
        elif line.startswith("## "):
            heading = Paragraph(inline(line[3:]), sty["section"])
            heading.bookmark_title = line[3:]
            story.append(heading)
        elif line.startswith("### "):
            story.append(Paragraph(inline(line[4:]), sty["sub"]))
        elif line.startswith("- "):
            story.append(Paragraph("• " + inline(line[2:]), sty["list"]))
        elif re.match(r"\d+\. ", line):
            story.append(Paragraph(inline(line), sty["list"]))
        elif line.startswith(("适用版本：", "更新日期：")):
            story.append(Paragraph(inline(line), sty["meta"]))
            if line.startswith("更新日期："):
                story.append(Spacer(1, 10))
        elif line.startswith(("#", ">", "```", "<!--")):
            raise ValueError(f"Unsupported Markdown block: {line}")
        else:
            paragraph = [line]
            while i < len(lines) and lines[i].strip():
                if re.match(r"^(#|\||-|\d+\. |<!--)", lines[i]):
                    break
                paragraph.append(lines[i].strip())
                i += 1
            story.append(Paragraph(inline(" ".join(paragraph)), sty["body"]))
    return story


class GuideDoc(SimpleDocTemplate):
    def afterFlowable(self, flowable):
        title = getattr(flowable, "bookmark_title", None)
        if title:
            key = f"chapter-{self.page}"
            self.canv.bookmarkPage(key)
            self.canv.addOutlineEntry(title, key, level=0, closed=False)


def page_frame(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(.6)
    canvas.line(42, A4[1] - 34, A4[0] - 42, A4[1] - 34)
    canvas.setFont("Guide", 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(42, A4[1] - 25, "双向云桥  /  OpenList Transfer")
    canvas.drawRightString(A4[0] - 42, A4[1] - 25, f"使用指南  ·  {VERSION}")
    canvas.line(42, 34, A4[0] - 42, 34)
    canvas.setFont("Guide", 7.5)
    canvas.drawString(42, 22, "夸克与 115 双向复制  ·  保留源文件")
    canvas.drawRightString(A4[0] - 42, 22, f"第 {doc.page} 页")
    canvas.restoreState()


def main():
    register_fonts()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    doc = GuideDoc(str(OUTPUT), pagesize=A4, leftMargin=42, rightMargin=42,
                   topMargin=48, bottomMargin=46, title="双向云桥 · 使用指南",
                   author="OpenList Transfer contributors", subject="夸克与115双向文件复制操作说明",
                   pageCompression=1)
    doc.build(parse(SOURCE.read_text(encoding="utf-8"), styles()),
              onFirstPage=page_frame, onLaterPages=page_frame)
    print(OUTPUT)


if __name__ == "__main__":
    main()
