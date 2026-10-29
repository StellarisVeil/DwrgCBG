# 皮肤监控清单生成脚本 (记录型清单, 无公式)
import os
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

OUT = r"D:/GitHubWork/dwrgCBG/2026-10-29/skin-monitor-list.xlsx"

# 轻量灰配色（自用数据清单）
HEADER_BG = "FFF2F2F2"
HEADER_FG = "FF1A1A1A"
THIN = Side(style="thin", color="FFBFBFBF")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

wb = Workbook()
ws = wb.active
ws.title = "皮肤清单"

# 表头（第1行）
headers = ["皮肤名", "参考价"]
for c, h in enumerate(headers, start=1):
    cell = ws.cell(row=1, column=c, value=h)
    cell.font = Font(bold=True, color=HEADER_FG)
    cell.fill = PatternFill("solid", fgColor=HEADER_BG)
    cell.alignment = Alignment(horizontal="center", vertical="center")
    cell.border = BORDER

# 数据（明确给定的 3 行）
rows = [
    ("于此岸赴宴", 300),
    ("蜃景", 1000),
    ("赤宴", 1200),
]
for i, (name, price) in enumerate(rows, start=2):
    ws.cell(row=i, column=1, value=name).border = BORDER
    pc = ws.cell(row=i, column=2, value=price)
    pc.number_format = "#,##0"
    pc.alignment = Alignment(horizontal="right")
    pc.border = BORDER

# 列宽
ws.column_dimensions["A"].width = 18
ws.column_dimensions["B"].width = 12

wb.properties.title = "皮肤监控清单"
wb.save(OUT)
print("saved:", OUT)
