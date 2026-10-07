#!/usr/bin/env python3
"""Team Memory screen boards, v2: one modal for first setup and for edits,
settings in modals, flat pages, a separate 관리자 tab. Writes out/project: one
.dc.html per board and the canvas.json of the Design artifact (see README.md)."""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out", "project")
# Used when out/project has no canvas.json yet. A canvas.json saved from the
# published artifact goes there instead, so the keys its editor wrote are kept.
NEW_CANVAS = {"v": 3, "title": "팀 메모리 화면 시안", "attachments": {}, "launch": {"view": "canvas"},
              "pages": [{"id": "page-1", "name": "Page 1"}]}
BW, BH = 1280, 860
MAP_H = 1480
PITCH_X = 1360

FONTS = ('<link rel="preconnect" href="https://fonts.googleapis.com">\n'
         '<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;600;700&display=swap" rel="stylesheet">')

CSS = """
*{box-sizing:border-box}
body{margin:0}
.app{position:relative;display:flex;width:1280px;height:860px;overflow:hidden;background:#faf8f4;font-family:'Noto Sans KR',sans-serif;color:#1d1c19;font-size:14px;line-height:1.5}
.side{width:232px;flex:none;background:#efece5;border-right:1px solid #e3dfd6;padding:20px 14px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:17px;padding:0 6px 22px}
.logo{width:28px;height:28px;border-radius:6px;background:#b5412a;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px}
.nav{display:flex;flex-direction:column;gap:2px}
.nav a{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:7px;color:#57534b;text-decoration:none}
.nav a.on{background:#fff;color:#1d1c19;box-shadow:0 0 0 1px #e3dfd6}
.nav svg{width:16px;height:16px;flex:none}
.nav a.on svg{color:#b5412a}
.nav .sep{height:1px;background:#ddd8cd;margin:10px 6px}
.nav.off a{color:#b3ad9f}
.main{flex:1;min-width:0}
.head{padding:24px 32px 18px;border-bottom:1px solid #e3dfd6}
.head h1{margin:0;font-size:22px;font-weight:700}
.head p{margin:6px 0 0;color:#6f6a60;font-size:13.5px}
.tabs{display:flex;gap:4px;margin-top:14px}
.tabs span{padding:6px 12px;border-radius:7px;color:#57534b;font-size:13.5px}
.tabs span.on{background:#fff;color:#1d1c19;box-shadow:0 0 0 1px #e3dfd6;font-weight:600}
.body{padding:22px 32px 32px;display:flex;flex-direction:column;gap:22px;max-width:980px}
.muted{color:#6f6a60}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
.sp{flex:1}
.t{display:flex;align-items:center;gap:8px;font-weight:600}
.s{margin-top:2px;color:#6f6a60;font-size:13px}
.tag{display:inline-block;padding:2px 8px;border-radius:5px;background:#f3f0ea;color:#57534b;font-size:12px;font-weight:500;white-space:nowrap}
.tag.ok{background:#e1ecdf;color:#2e5c3a}
.tag.warn{background:#f4e8d2;color:#7d510c}
.tag.new{background:#e4ecf6;color:#2c4f7c}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:7px 15px;border-radius:7px;border:1px solid #d2ccc0;background:#fff;font:inherit;font-size:13px;color:#1d1c19;white-space:nowrap}
.btn.pri{background:#b5412a;border-color:#b5412a;color:#fff}
.btn.quiet{border-color:transparent;background:none;color:#57534b}
.btn.danger{border-color:transparent;background:none;color:#b3261e}
.btn.dangerfill{background:#b3261e;border-color:#b3261e;color:#fff}
.btn.sm{padding:5px 11px;font-size:12.5px}
.hit{box-shadow:0 0 0 3px #f0a868 !important}
a.hit{box-shadow:0 0 0 3px #f0a868 !important}
.notice{padding:12px 16px;border-radius:10px;border:1px solid #dcc89f;background:#fbf5e8;font-size:13.5px}
.notice.ok{border-color:#bcd3b8;background:#eef5ec;color:#24492e}
.notice.warn{border-color:#e2c48f;background:#fbf1de;color:#5e3d08}
.toast{position:absolute;left:756px;bottom:28px;transform:translateX(-50%);display:flex;align-items:center;gap:10px;padding:10px 18px 10px 12px;border-radius:10px;background:#2b2a26;color:#fff;font-size:13.5px;box-shadow:0 8px 24px rgba(20,18,14,.25)}
.toast .ic.ok{background:#3b7449;color:#fff}
.bell{position:absolute;top:22px;right:32px;width:36px;height:36px;border:1px solid #e3dfd6;border-radius:9px;background:#fff;display:flex;align-items:center;justify-content:center;color:#57534b}
.bell svg{width:18px;height:18px}
.bell b{position:absolute;top:-7px;right:-7px;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#b5412a;color:#fff;font-size:11px;font-weight:700;line-height:18px;text-align:center}
.pop{position:absolute;top:66px;right:24px;width:460px;background:#fff;border:1px solid #e3dfd6;border-radius:12px;box-shadow:0 16px 40px rgba(20,18,14,.18);overflow:hidden}
.pop-h{padding:12px 16px;border-bottom:1px solid #ece8e0;font-weight:700}
.switch{width:34px;height:20px;border-radius:10px;background:#c9c3b6;position:relative;flex:none;display:inline-block}
.switch.on{background:#3b7449}
.switch:after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2)}
.switch.on:after{left:16px}
h2.sec{margin:0 0 10px;font-size:13px;font-weight:600;color:#57534b}
.card{border:1px solid #e3dfd6;border-radius:10px;background:#fff}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;background:#3b7449;flex:none}
.dot.warn{background:#9a6410}
.dot.idle{background:#c9c3b6}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{padding:9px 16px;border-bottom:1px solid #e3dfd6;color:#6f6a60;font-size:12.5px;font-weight:500;text-align:left}
td{padding:12px 16px;border-bottom:1px solid #e3dfd6}
tr:last-child td{border-bottom:0}
.num{text-align:right;font-variant-numeric:tabular-nums}
.nm{display:flex;align-items:center;gap:8px;font-weight:600}
.addr{margin:2px 0 0 16px;color:#6f6a60;font-size:12.5px}
.queue{margin-top:10px;padding:12px 16px}
.queue-head{display:flex;justify-content:space-between;color:#57534b;font-size:13px}
.queue-head b{color:#1d1c19;font-weight:600}
.bar{height:6px;margin-top:8px;border-radius:3px;background:#f3f0ea;overflow:hidden}
.bar span{display:block;height:100%;background:#3b7449}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.tile{padding:14px 16px 15px;display:flex;flex-direction:column;gap:3px}
.tile-head{display:flex;align-items:center;gap:8px;color:#57534b;font-size:13px;font-weight:500}
.tile b{margin-top:4px;font-size:17px;font-weight:600}
.tile small{color:#6f6a60;font-size:12.5px}
.blk{border:1px solid #e3dfd6;border-radius:12px;background:#fff;padding:2px 18px 4px}
.blk-h{display:flex;align-items:center;gap:10px;padding:12px 0 10px;border-bottom:1px solid #ece8e0}
.blk-h h2{margin:0;font-size:15.5px;font-weight:700}
.kv{display:flex;align-items:flex-start;gap:16px;padding:11px 0;border-bottom:1px solid #f0ece4}
.kv:last-child{border-bottom:0}
.kv .k{width:136px;flex:none;color:#6f6a60;font-size:13px;padding-top:1px}
.kv .v{flex:1;min-width:0}
.kv .end{margin-left:auto}
.sec-h{display:flex;align-items:center;gap:10px;margin:0 0 8px}
.sec-h h2{margin:0;font-size:15px;font-weight:700}
.list{border:1px solid #e3dfd6;border-radius:12px;background:#fff;overflow:hidden}
.item{display:flex;align-items:center;gap:14px;padding:12px 16px;border-bottom:1px solid #f0ece4}
.item:last-child{border-bottom:0}
.item.new{background:#f2f7f0}
.item .v{flex:1;min-width:0}
.item .end{display:flex;align-items:center;gap:6px}
.empty{padding:14px 16px;color:#6f6a60;font-size:13.5px}
.scrim{position:absolute;inset:0;background:rgba(36,33,28,.42)}
.modal{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:680px;background:#fff;border-radius:14px;box-shadow:0 24px 64px rgba(20,18,14,.3);display:flex;flex-direction:column;overflow:hidden}
.modal.sm{width:560px}
.m-head{display:flex;align-items:center;gap:10px;padding:16px 22px 0}
.m-head .mt{font-size:13px;font-weight:600;color:#6f6a60}
.m-head.big{padding:20px 22px 2px}
.m-head.big .mt{font-size:18px;font-weight:700;color:#1d1c19}
.m-head .x{margin-left:auto;width:28px;height:28px;border-radius:7px;display:flex;align-items:center;justify-content:center;color:#6f6a60;font-size:16px}
.stepper{display:flex;align-items:center;gap:6px;padding:12px 22px 14px;border-bottom:1px solid #ece8e0;font-size:12.5px;color:#8a8478}
.stepper .st{display:flex;align-items:center;gap:6px;white-space:nowrap;padding:2px 4px;border-radius:6px}
.stepper .n{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;border:1px solid #c9c3b6;font-size:12px}
.stepper .on{color:#1d1c19;font-weight:600}
.stepper .on .n{border-color:#b5412a;color:#b5412a}
.stepper .done{color:#57534b}
.stepper .done .n{background:#e1ecdf;border-color:#e1ecdf;color:#2e5c3a}
.stepper .line{flex:1;min-width:6px;max-width:28px;height:1px;background:#d2ccc0}
.stepper.link .st:not(.on){text-decoration:underline;text-decoration-color:#c9c3b6;text-underline-offset:4px;color:#57534b}
.m-body{padding:20px 22px 6px}
.m-body h3{margin:0 0 4px;font-size:18px;font-weight:700}
.m-body .lead{margin:0 0 14px;color:#6f6a60;font-size:13.5px}
.m-foot{display:flex;align-items:center;gap:8px;padding:16px 22px 18px}
.label{margin:16px 0 8px;font-size:12.5px;font-weight:600;color:#57534b}
.label:first-child{margin-top:4px}
.opts{border:1px solid #e3dfd6;border-radius:10px;overflow:hidden}
.opt{display:flex;align-items:flex-start;gap:12px;padding:12px 14px;border-bottom:1px solid #ece8e0}
.opt:last-child{border-bottom:0}
.opt.sel{background:#fbf3f0}
.opt.dis{color:#a9a395}
.opt.dis .os{color:#b3ad9f}
.opt .ob{flex:1;min-width:0}
.opt .ot{font-weight:600;display:flex;align-items:center;gap:8px}
.opt .os{color:#6f6a60;font-size:12.5px;margin-top:2px}
.opt .oe{display:flex;align-items:center;gap:8px;margin-top:1px}
.radio{width:16px;height:16px;border:1.5px solid #bdb6a8;border-radius:50%;flex:none;margin-top:3px}
.radio.on{border:5px solid #b5412a}
.box{width:16px;height:16px;border:1.5px solid #bdb6a8;border-radius:4px;flex:none;margin-top:3px;position:relative;display:inline-block}
.box.on{background:#b5412a;border-color:#b5412a}
.box.on:after{content:"";position:absolute;left:4px;top:1px;width:4px;height:8px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}
.box.dis{border-color:#d8d3c8;background:#f3f0ea}
.src{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:5px;background:#c0693f;color:#fff;font-size:11px;font-weight:700}
.src.x{background:#2b2a26}
.src.g{background:#6b665c}
.cnt-l{color:#6f6a60;font-size:12.5px}
.cnt{display:inline-flex;align-items:center;border:1px solid #d8d3c8;border-radius:7px;background:#fff;font-size:13px}
.cnt i{font-style:normal;width:26px;text-align:center;color:#57534b}
.cnt b{min-width:26px;text-align:center;font-weight:600;border-left:1px solid #ece8e0;border-right:1px solid #ece8e0;padding:2px 0}
.field{margin-top:12px}
.field label{display:block;font-size:12.5px;font-weight:600;color:#57534b;margin-bottom:6px}
.input{display:flex;align-items:center;height:38px;padding:0 12px;border:1px solid #d2ccc0;border-radius:8px;background:#fff;font-size:14px}
.input.mono{font-family:ui-monospace,Menlo,monospace;font-size:13px}
.input.ph{color:#a9a395}
.hint{margin-top:6px;color:#6f6a60;font-size:12.5px}
.sub{margin:10px 0 2px 28px;padding:12px 14px;border-radius:8px;background:#f7f5f0}
.sub .field:first-child{margin-top:0}
.fold{margin-top:12px;color:#57534b;font-size:13px}
.pt{border:1px solid #e3dfd6;border-radius:10px;overflow:hidden}
.pr{display:grid;grid-template-columns:24px 1fr 84px;align-items:center;gap:10px;padding:9px 14px;border-bottom:1px solid #ece8e0}
.pr.m{grid-template-columns:1fr 70px 104px 104px}
.pr:last-child{border-bottom:0}
.pr.h{background:#f7f5f0;color:#6f6a60;font-size:12.5px;font-weight:500;padding:8px 14px}
.pr.fresh{background:#f2f7f0}
.pr .box{margin-top:0}
.pr .pn b{font-weight:600}
.pr .pn small{display:block;color:#6f6a60;font-size:12px;font-family:ui-monospace,Menlo,monospace}
.pr .c{text-align:right;color:#57534b;font-variant-numeric:tabular-nums;font-size:13px}
.pr .cc{display:flex;justify-content:center}
.pr .ch{text-align:center;line-height:1.3}
.row2{display:flex;align-items:center;gap:12px;margin-top:12px;font-size:13.5px}
.row2 .box{margin-top:0}
.seg{display:inline-flex;border:1px solid #d2ccc0;border-radius:8px;overflow:hidden}
.seg span{padding:5px 12px;font-size:13px;color:#57534b;border-right:1px solid #d2ccc0}
.seg span:last-child{border-right:0}
.seg span.on{background:#1d1c19;color:#fff}
.prog{border:1px solid #e3dfd6;border-radius:10px;overflow:hidden;margin-top:12px}
.pg{display:flex;align-items:center;gap:12px;min-height:64px;padding:12px 14px;border-bottom:1px solid #ece8e0}
.pgl{padding:7px 14px;background:#f7f5f0;border-bottom:1px solid #ece8e0;color:#6f6a60;font-size:12.5px;font-weight:600}
.pg:last-child{border-bottom:0}
.ic{width:20px;height:20px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:11px;flex:none}
.ic.ok{background:#e1ecdf;color:#2e5c3a}
.ic.run{border:2px solid #b5412a;border-right-color:transparent}
.ic.wait{border:1.5px solid #c9c3b6}
.pg .pb{flex:1;min-width:0}
.pg .pgt{font-weight:600}
.pg.wait .pgt{color:#8a8478;font-weight:500}
.pg .pgs{color:#6f6a60;font-size:12.5px}
.minibar{width:150px;height:6px;border-radius:3px;background:#f3f0ea;overflow:hidden}
.minibar span{display:block;height:100%;background:#b5412a}
.todo{margin:14px 0 4px;padding:0;list-style:none;counter-reset:todo;border:1px solid #e3dfd6;border-radius:10px;overflow:hidden}
.todo li{display:flex;gap:12px;padding:13px 14px;border-bottom:1px solid #ece8e0;counter-increment:todo}
.todo li:last-child{border-bottom:0}
.todo li:before{content:counter(todo);display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:#efece5;color:#57534b;font-size:12px;font-weight:600;flex:none}
.todo b{display:block;font-weight:600}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:14px}
.cardopt{border:1px solid #e3dfd6;border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:8px;min-height:188px}
.cardopt b{font-size:15.5px}
.cardopt p{margin:0;color:#6f6a60;font-size:13px;flex:1}
.cardopt .btn{align-self:stretch}
.waitline{display:flex;align-items:center;gap:10px;margin-top:14px;color:#57534b}
.spin{width:16px;height:16px;border-radius:50%;border:2px solid #b5412a;border-right-color:transparent;display:inline-block;flex:none}
.idbox{margin-top:12px;padding:12px 14px;border-radius:8px;background:#f7f5f0;display:flex;align-items:center;gap:10px}
.agent{display:flex;align-items:flex-start;gap:12px;padding:14px;border-bottom:1px solid #ece8e0}
.agent:last-child{border-bottom:0}
.agent .ab{flex:1;min-width:0}
.swrow{display:flex;align-items:center;gap:12px;padding:13px 14px;border-bottom:1px solid #ece8e0}
.swrow:last-child{border-bottom:0}
.swrow .ab{flex:1}
.file{display:flex;align-items:center;gap:12px;margin-top:14px;padding:12px 14px;border:1px dashed #c9c3b6;border-radius:10px}
"""

ICON = {
    "대시보드": '<path d="M2.75 11.5a5.25 5.25 0 0110.5 0"/><path d="M8 11.5l2.25-3.25"/>',
    "기억": '<path d="M3 2.5h7.5L13 5v8.5H3z"/><path d="M10.5 2.5V5H13"/><path d="M5.5 8h5M5.5 10.5h3.5"/>',
    "기억 설정": '<path d="M2.5 4.5h4M9.5 4.5h4M2.5 11.5h7M12.5 11.5h1"/><circle cx="8" cy="4.5" r="1.5"/><circle cx="11" cy="11.5" r="1.5"/>',
    "팀": '<circle cx="8" cy="5.5" r="2.75"/><path d="M2.75 13.5c.75-2.5 2.75-3.75 5.25-3.75s4.5 1.25 5.25 3.75"/>',
    "서버": '<rect x="2.5" y="2.5" width="11" height="4.5" rx="1"/><rect x="2.5" y="9" width="11" height="4.5" rx="1"/><path d="M5 4.75h.01M5 11.25h.01"/>',
    "백업": '<path d="M8 2.5v7M5 7l3 3 3-3"/><path d="M2.5 10.5v3h11v-3"/>',
    "관리자": '<path d="M8 1.75l5 2v4.1c0 3-2.1 5.1-5 6.4-2.9-1.3-5-3.4-5-6.4v-4.1z"/><path d="M5.75 8l1.5 1.5 3-3"/>',
    "알림": '<path d="M4.25 7a3.75 3.75 0 017.5 0v3l1.25 2H3l1.25-2z"/><path d="M6.5 13.5a1.5 1.5 0 003 0"/>',
}
NAVS = {
    "member": ["대시보드", "기억", "기억 설정", "팀", "서버", "백업"],
    "admin": ["대시보드", "기억", "기억 설정", "팀", "서버", "백업", "|", "관리자"],
    "solo": ["대시보드", "기억", "기억 설정", "서버", "백업"],
    "chat": ["대시보드", "기억 설정", "팀", "백업"],
    "blank": ["대시보드", "기억", "기억 설정", "팀", "서버", "백업"],
}


def svg(name):
    return ('<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" '
            'stroke-linecap="round" stroke-linejoin="round">' + ICON[name] + "</svg>")


def side(kind="member", on=None, hit=None):
    out = []
    for item in NAVS[kind]:
        if item == "|":
            out.append('<div class="sep"></div>')
            continue
        cls = []
        if item == on:
            cls.append("on")
        if item == hit:
            cls.append("hit")
        c = ' class="' + " ".join(cls) + '"' if cls else ""
        out.append("<a" + c + ' href="#">' + svg(item) + item + "</a>")
    nav_cls = "nav off" if kind == "blank" else "nav"
    return ('<aside class="side"><div class="brand"><span class="logo">기</span>팀 메모리</div>'
            '<nav class="' + nav_cls + '" aria-label="메뉴">' + "".join(out) + "</nav></aside>")


def btn(label, kind="", hit=False, sm=False):
    cls = ["btn"]
    if kind:
        cls.append(kind)
    if sm:
        cls.append("sm")
    if hit:
        cls.append("hit")
    return '<button class="' + " ".join(cls) + '" type="button">' + label + "</button>"


def tag(text, kind=""):
    return '<span class="tag' + (" " + kind if kind else "") + '">' + text + "</span>"


def bell():
    return '<span class="bell">' + svg("알림") + "</span>"


def ring(screen, n=1, hit=False, items=None):
    """The page's bell with a count, and with its list open when items are given."""
    side_html, main_html, modal_html = screen
    b = '<span class="bell' + (" hit" if hit else "") + '">' + svg("알림") + "<b>" + str(n) + "</b></span>"
    if items:
        b += '<div class="pop"><div class="pop-h">알림</div>' + "".join(items) + "</div>"
    if bell() not in main_html:
        raise ValueError("no bell on this page")
    return side_html, main_html.replace(bell(), b, 1), modal_html


def head(title, desc, tabs=None, tab_on=None):
    t = ""
    if tabs:
        t = '<div class="tabs">' + "".join(
            '<span class="on">' + x + "</span>" if x == tab_on else "<span>" + x + "</span>" for x in tabs) + "</div>"
    return '<header class="head">' + bell() + "<h1>" + title + "</h1><p>" + desc + "</p>" + t + "</header>"


# ---------------------------------------------------------------- pages

LOCAL = "127.0.0.1:8001"
MY_SERVER = "memory-me.example.com"
COMPANY = "memory.company.example"
LAN = "192.168.0.20:8001"
ME = "me@example.com"
TEAM_ADDR = "team.example.com"


def dashboard(rows, queue="77% · 남은 일 312개 · 지금 4개", pct=77, share=("켜짐", MY_SERVER)):
    trs = ""
    for state, name, addr, status, pending, last, total in rows:
        dot = {"on": "dot", "warn": "dot warn", "idle": "dot idle"}[state]
        trs += ('<tr><td><div class="nm"><span class="' + dot + '"></span>' + name + '</div><div class="addr">' + addr
                + "</div></td><td>" + status + '</td><td class="num">' + pending + "</td><td>" + last
                + '</td><td class="num">' + total + "</td></tr>")
    share_dot = "dot" if share[0] == "켜짐" else "dot idle"
    return (head("대시보드", "이 컴퓨터의 기억이 지금 어떻게 돌고 있는지 봅니다.")
            + '<div class="body">'
            + '<section><h2 class="sec">동기화 현황</h2><div class="card"><table><thead><tr><th>서버</th><th>상태</th>'
              '<th class="num">남은 대화</th><th>마지막 동기화</th><th class="num">서버의 대화</th></tr></thead><tbody>'
            + trs + "</tbody></table></div>"
            + '<div class="card queue"><div class="queue-head"><b>Honcho 처리</b><span>' + queue
            + '</span></div><div class="bar"><span style="width:' + str(pct) + '%"></span></div></div></section>'
            + '<section><h2 class="sec">모델 · 백업 · 공유</h2><div class="grid">'
              '<div class="card tile"><div class="tile-head"><span class="dot"></span>구독 게이트웨이</div><b>계정 2개 쓰는 중</b><small>모델 14개</small></div>'
              '<div class="card tile"><div class="tile-head"><span class="dot"></span>백업</div><b>21시간 전</b><small>매일 03:02 · gdrive:대화</small></div>'
              '<div class="card tile"><div class="tile-head"><span class="' + share_dot + '"></span>공유</div><b>' + share[0]
            + "</b><small>" + share[1] + "</small></div></div></section></div>")


ROW_LOCAL = ("on", "이 컴퓨터 서버", LOCAL, "동기화 중", "3개", "3분 전", "18,373개")


def kv(k, v, end=""):
    return ('<div class="kv"><span class="k">' + k + '</span><span class="v">' + v + "</span>"
            + ('<span class="end">' + end + "</span>" if end else "") + "</div>")


def settings(collect, toast=None, hit=None):
    return (head("기억 설정", "이 컴퓨터의 대화를 어디에 쌓고, 에이전트가 무엇을 쓸지 정합니다.")
            + '<div class="body">'
            + '<section class="blk"><div class="blk-h"><h2>대화 수집</h2>' + tag("켜짐", "ok") + '<span class="sp"></span>' + btn("수정", hit=hit == "collect") + "</div>"
            + "".join(kv(k, v) for k, v in collect) + "</section>"
            + '<section class="blk"><div class="blk-h"><h2>MCP 도구</h2><span class="sp"></span>'
            + btn("수정", hit=hit == "mcp") + "</div>"
            + kv("찾기 도구", "20개 중 20개 켜짐") + kv("바꾸기·지우기 도구", "11개 중 0개 켜짐") + "</section>"
            + '<section class="blk"><div class="blk-h"><h2>ChatGPT 기록</h2><span class="sp"></span>'
            + btn("가져오기", hit=hit == "import") + "</div>"
            + kv("기억에 있는 대화", "4,071개 · 9월 30일에 가져옴") + "</section></div>"
            + ('<div class="toast"><span class="ic ok">✓</span>' + toast + "</div>" if toast else ""))


COLLECT_BASE = [
    ("서버", '이 컴퓨터 서버 <span class="mono muted">' + LOCAL + "</span>"),
    ("peer 이름", 'me <span class="muted">· ' + ME + "에서</span>"),
    ("에이전트", "Claude Code · Codex"),
    ("프로젝트 폴더", 'honcho · web-app · api-server<div class="s">새로 생기는 폴더도 수집</div>'),
]
COLLECT_NOTES = COLLECT_BASE[:3] + [
    ("프로젝트 폴더", 'honcho · web-app · api-server · notes<div class="s">새로 생기는 폴더도 수집</div>'),
]
COLLECT_COMPANY = [
    ("서버", '이 컴퓨터 서버 <span class="mono muted">' + LOCAL + '</span><div style="margin-top:6px">회사 <span class="mono muted">'
     + COMPANY + "</span> " + tag("승인 기다리는 중", "warn") + "</div>"),
    ("peer 이름", 'me <span class="muted">· ' + ME + "에서</span>"),
    ("에이전트", "Claude Code · Codex"),
    ("프로젝트 폴더", 'honcho · web-app · api-server · notes<div class="s">새로 생기는 폴더도 수집</div>'
     '<div style="margin-top:6px">회사: honcho</div>'),
]


def item(name, tags="", sub="", end="", cls=""):
    return ('<div class="item' + (" " + cls if cls else "") + '"><div class="v"><div class="t">' + name + tags
            + "</div>" + ('<div class="s">' + sub + "</div>" if sub else "") + "</div>"
            + ('<div class="end">' + end + "</div>" if end else "") + "</div>")


def section(title, items, right="", empty=None):
    body = "".join(items) if items else '<div class="empty">' + (empty or "없습니다.") + "</div>"
    return ('<section><div class="sec-h"><h2>' + title + '</h2><span class="sp"></span>' + right + "</div>"
            '<div class="list">' + body + "</div></section>")


def team(mates=None, granted=None, granted_title="내 기억을 여는 팀원"):
    parts = [section("팀원 기억", mates or [])]
    if granted is not None:
        parts.append(section(granted_title, granted, empty="아직 없습니다."))
    return (head("팀", "팀원의 기억에 chat으로 묻고, 내 기억을 누구에게 열었는지 봅니다.")
            + '<div class="body">' + "".join(parts) + "</div>")


SWITCH_ON = '<span class="switch on"></span>'
SWITCH_OFF = '<span class="switch"></span>'
MATE_ALICE = item("alice", "", "Claude Code·Codex · 열린 프로젝트 2개", SWITCH_ON)
MATE_DAVE = item("dave", "", "꺼 둠 · 열린 프로젝트 2개", SWITCH_OFF)
MATE_CAROL = item("carol", "", "서버 없음")
GRANT_ALICE = lambda hit=False: item("alice", " " + tag("chat"), "열린 프로젝트: honcho · web-app", btn("수정", sm=True, hit=hit))


def share_page(server, computers):
    return (head("서버", "내 다른 컴퓨터와 팀원이 이 서버에 닿게 엽니다.", ["기억 서버", "모델", "공유"], "공유")
            + '<div class="body">'
            + '<section class="blk"><div class="blk-h"><h2>공유</h2>' + tag("켜짐", "ok")
            + '<span class="sp"></span>' + btn("공유 끄기") + "</div>"
            + kv("이 서버의 주소", '<span class="mono">https://' + server + "</span>") + "</section>"
            + section("이 서버에 쌓는 컴퓨터", computers) + "</div>")


def admin_page(members, hit=None):
    return (head("관리자", "팀원 명단과 팀 주소를 관리합니다.")
            + '<div class="body">'
            + '<section class="blk"><div class="blk-h"><h2>팀</h2></div>'
            + kv("팀 이름", "예시 팀")
            + kv("팀 주소", '<span class="mono">https://' + TEAM_ADDR + '</span><div class="s">새 팀원에게 이 주소를 보내세요.</div>',
                 btn("복사", sm=True)) + "</section>"
            + section("팀원 " + str(len(members)) + "명", members, btn("팀원 더하기", "pri", hit=hit == "add"))
            + '<section class="blk"><div class="blk-h"><h2>Cloudflare</h2><span class="sp"></span>' + btn("token 바꾸기")
            + "</div>" + kv("도메인", "example.com") + kv("API token", "9월 30일에 넣음") + "</section></div>")


def members(hit_bob=False, erin=False):
    rows = [
        item("admin@example.com", " " + tag("나 · 관리자"), "서버 " + COMPANY),
        item("me@example.com", "", "서버 " + MY_SERVER, btn("팀에서 빼기", "danger", sm=True)),
        item("alice@example.com", "", "서버 memory-alice.example.com", btn("팀에서 빼기", "danger", sm=True)),
        item("bob@example.com", "", "서버 memory-bob.example.com", btn("팀에서 빼기", "danger", sm=True, hit=hit_bob)),
        item("carol@example.com", "", "아직 로그인하지 않음", btn("팀에서 빼기", "danger", sm=True)),
        item("dave@example.com", "", "서버 memory-dave.example.com", btn("팀에서 빼기", "danger", sm=True)),
    ]
    if erin:
        rows.append(item("erin@example.com", " " + tag("방금 더함", "new"), "아직 로그인하지 않음",
                         btn("팀에서 빼기", "danger", sm=True), cls="new"))
    return rows


def backup_page(hit=None):
    return (head("백업", "이 컴퓨터의 대화 원본을 폴더나 클라우드에 그대로 복사합니다.")
            + '<div class="body"><section class="blk"><div class="blk-h"><h2>백업</h2>' + tag("연결됨", "ok")
            + '<span class="sp"></span>' + btn("지금 백업") + btn("수정", hit=hit == "edit") + "</div>"
            + kv("백업할 곳", '클라우드 <span class="mono muted">gdrive:대화</span>')
            + kv("자동 백업", "매일 03:02")
            + kv("마지막 백업", '21시간 전<div class="s">새로 복사 12개 · 그대로 18,361개</div>') + "</section></div>")


def models_page(hit=None):
    accounts = [("ChatGPT", "me@example.com", "쓰는 중"), ("ChatGPT", "work@example.com", "쓰는 중"),
                ("Claude", "me@example.com", "사용 한도 · 오후 2:00에 풀림")]
    rows = "".join(item(a + ' <span class="mono muted">' + e + "</span>", "", st, btn("로그아웃", "quiet", sm=True))
                   for a, e, st in accounts)
    return (head("서버", "기억 서버가 쓰는 모델, 구독 게이트웨이, 임베딩 모델을 관리합니다.", ["기억 서버", "모델", "공유"], "모델")
            + '<div class="body">'
            + section("구독 계정 3개", [rows], btn("계정 더하기", hit=hit == "account"))
            + '<section class="blk"><div class="blk-h"><h2>기억 서버가 쓰는 모델</h2><span class="sp"></span>'
            + btn("수정", hit=hit == "model") + "</div>" + kv("정리·묻기 모델", '<span class="mono">gpt-6.1-sol</span> · ChatGPT') + "</section>"
            + '<section class="blk"><div class="blk-h"><h2>임베딩 모델</h2></div>'
            + kv("모델", '<span class="mono">qwen3-embedding</span> · Ollama에 올라가 있음') + "</section></div>")


def tall(screen, h=1080):
    return tuple(screen) + (h,)


# ---------------------------------------------------------------- modal parts

TEAM = ["로그인", "서버", "에이전트", "프로젝트", "팀원"]
JOIN = ["팀 주소", "로그인", "서버", "에이전트", "프로젝트", "팀원"]
MAKE = ["팀 만들기", "로그인", "서버", "에이전트", "프로젝트"]
SOLO = ["서버", "에이전트", "프로젝트"]
EDIT = ["서버", "에이전트", "프로젝트"]
CHATONLY = ["로그인", "서버", "팀원"]
TEAM_NEW = ["로그인", "서버", "모델", "에이전트", "프로젝트", "팀원"]
MAKE_NEW = ["팀 만들기", "로그인", "서버", "모델", "에이전트", "프로젝트"]
SOLO_NEW = ["서버", "모델", "에이전트", "프로젝트"]
START = "팀 메모리 시작하기"
EDIT_TITLE = "대화 수집 설정"


def stepper(steps, at, link=False, hit=None):
    parts = []
    for i, s in enumerate(steps):
        if i:
            parts.append('<span class="line"></span>')
        if at == "done" or (isinstance(at, int) and i < at):
            cls, n = "st done", "✓"
        elif i == at:
            cls, n = "st on", str(i + 1)
        else:
            cls, n = "st", str(i + 1)
        if hit == i:
            cls += " hit"
        parts.append('<span class="' + cls + '"><span class="n">' + n + "</span>" + s + "</span>")
    return '<div class="stepper' + (" link" if link else "") + '">' + "".join(parts) + "</div>"


def wizard(title, steps, at, body, foot, close=False, link=False, hit_step=None):
    x = '<span class="x">✕</span>' if close else ""
    st = stepper(steps, at, link, hit_step) if steps else ""
    return ('<div class="scrim"></div><div class="modal"><div class="m-head"><span class="mt">' + title + "</span>" + x
            + "</div>" + st + '<div class="m-body">' + body + '</div><div class="m-foot">' + foot + "</div></div>")


def simple(title, body, foot):
    return ('<div class="scrim"></div><div class="modal sm"><div class="m-head big"><span class="mt">' + title
            + '</span><span class="x">✕</span></div><div class="m-body">' + body + '</div><div class="m-foot">'
            + foot + "</div></div>")


def opt(kind, on, title, sub="", end="", dis=False, extra=""):
    mark = '<span class="' + kind + (" on" if on else "") + (" dis" if dis and kind == "box" else "") + '"></span>'
    cls = "opt" + (" sel" if on and kind == "radio" else "") + (" dis" if dis else "")
    return ('<div class="' + cls + '">' + mark + '<div class="ob"><div class="ot">' + title + "</div>"
            + ('<div class="os">' + sub + "</div>" if sub else "") + extra + "</div>"
            + ('<div class="oe">' + end + "</div>" if end else "") + "</div>")


def foot(left="", right=""):
    return left + '<span class="sp"></span>' + right


def peer_field(name="me"):
    return ('<div class="field"><label>내 peer 이름</label><div class="input">' + name + '</div>'
            '<div class="hint">내 모든 컴퓨터에서 같은 이름을 쓰세요.</div></div>')


NEW_SERVER_SUB = "ChatGPT나 Claude 구독이 필요합니다."


def company_opts(on=False):
    return ('<div class="label">함께 쌓을 서버</div><div class="opts">'
            + opt("box", on, '회사 <span class="mono muted">' + COMPANY + "</span>", end=tag("승인 요청", "warn"))
            + "</div>")


def w1_body(kind, company=False):
    """The server step. kind picks what this account has and what is chosen."""
    q = "<h3>어디에 쌓을까요?</h3>"
    if kind == "found":
        return (q + '<div class="label">내 기억 서버</div><div class="opts">'
                + opt("radio", True, '내 서버 <span class="mono muted">' + MY_SERVER + "</span>", "MacBook에서 만든 서버",
                      tag("찾음", "ok"))
                + opt("radio", False, "이 컴퓨터에 새로 만들기", NEW_SERVER_SUB)
                + opt("radio", False, "쌓지 않기")
                + "</div>" + company_opts(company))
    if kind == "none":
        return (q + "<p class=\"lead\">" + ME + " 계정에는 아직 기억 서버가 없습니다.</p>" + '<div class="opts">'
                + opt("radio", True, "이 컴퓨터에 새로 만들기", NEW_SERVER_SUB)
                + opt("radio", False, "쌓지 않기")
                + "</div>" + company_opts())
    if kind == "none-admin":
        return (q + "<p class=\"lead\">admin@example.com 계정에는 아직 기억 서버가 없습니다.</p>" + '<div class="opts">'
                + opt("radio", True, "이 컴퓨터에 새로 만들기", NEW_SERVER_SUB)
                + opt("radio", False, "쌓지 않기")
                + "</div>")
    if kind == "skip":
        return (q + "<p class=\"lead\">" + ME + " 계정에는 아직 기억 서버가 없습니다.</p>" + '<div class="opts">'
                + opt("radio", False, "이 컴퓨터에 새로 만들기", NEW_SERVER_SUB)
                + opt("radio", True, "쌓지 않기")
                + "</div>")
    if kind == "solo-local":
        return (q + '<div class="opts">'
                + opt("radio", True, "이 컴퓨터에 새로 만들기", NEW_SERVER_SUB)
                + opt("radio", False, "다른 컴퓨터의 내 서버", "그 컴퓨터에서 만든 서버의 주소를 넣습니다.")
                + "</div>" + peer_field())
    if kind == "solo-remote":
        fields = ('<div class="sub"><div class="field"><label>서버 주소</label><div class="input mono">http://' + LAN
                  + '</div></div><div class="field"><label>서버 token</label><div class="input mono">••••••••••••••••</div>'
                  '<div class="hint">그 서버가 token을 요구할 때만 넣습니다. 채팅에 붙여 넣지 말고 여기에만 넣으세요.</div></div></div>')
        return (q + '<div class="opts">'
                + opt("radio", False, "이 컴퓨터에 새로 만들기", NEW_SERVER_SUB)
                + opt("radio", True, "다른 컴퓨터의 내 서버", "그 컴퓨터에서 만든 서버의 주소를 넣습니다.", extra=fields)
                + "</div>" + peer_field())
    if kind in ("edit", "edit-company"):
        on = kind == "edit-company"
        return (q + '<div class="label">내 기억 서버</div><div class="opts">'
                + opt("radio", True, '이 컴퓨터 서버 <span class="mono muted">' + LOCAL + "</span>", "", tag("지금 쌓는 중", "ok"))
                + opt("radio", False, "쌓지 않기")
                + "</div>" + company_opts(on))
    raise ValueError(kind)


# Agent folders found on this computer: (icon class, letter, name, folder).
AGENTS_FOUND = [("src", "C", "Claude Code", "~/.claude"), ("src x", "X", "Codex", "~/.codex")]
AGENTS_GROK = AGENTS_FOUND + [("src g", "G", "Grok CLI", "~/.grok")]


# ChatGPT has no hook, so first setup takes its export file here and imports it before the
# agents' past conversations. Later imports go through 기억 설정 → ChatGPT 기록 (3-4).
CHATGPT_FILE = '<span class="mono">chatgpt-export.zip</span> · 48MB · 대화 312개'


def w2_body(edit=False, agents=AGENTS_FOUND, chatgpt=False):
    t = tag("수집 중", "ok") if edit else ""
    rows = "".join(opt("box", True, '<span class="' + cls + '">' + letter + "</span>" + name,
                       '<span class="mono">' + folder + "</span>", t) for cls, letter, name, folder in agents)
    gpt = ""
    if not edit:
        gpt = ('<div class="label">파일로 가져오는 대화</div><div class="opts">'
               + (opt("box", True, "ChatGPT", CHATGPT_FILE, btn("다른 파일", "quiet", sm=True)) if chatgpt else
                  opt("box", False, "ChatGPT", "ChatGPT의 설정 → 데이터 제어 → 데이터 내보내기로 받은 zip 파일",
                      btn("파일 고르기", sm=True)))
               + "</div>")
    return ("<h3>어느 에이전트의 대화를 수집할까요?</h3><p class=\"lead\">이 컴퓨터에서 찾은 에이전트입니다.</p>"
            '<div class="opts">' + rows + "</div>" + gpt)


PROJECTS = [("honcho", "~/dev/honcho", 33), ("web-app", "~/dev/web-app", 104),
            ("api-server", "~/dev/api-server", 292), ("notes", "~/Documents/notes", 14)]


# The ticked folders' past conversations all go in when 적용 runs, so there is nothing to choose.
def w3_body(checked=("honcho", "web-app", "api-server"), fresh=(), past="고른 폴더의 지난 대화 429개도 함께 수집합니다."):
    every = all(name in checked for name, _p, _n in PROJECTS)
    rows = ['<div class="pr h"><span class="box' + (" on" if every else "") + '"></span><span>폴더</span><span class="c">대화</span></div>']
    for name, path, n in PROJECTS:
        on = name in checked
        cls = "pr fresh" if name in fresh else "pr"
        t = " " + tag("새로 고름", "new") if name in fresh else ""
        rows.append('<div class="' + cls + '"><span class="box' + (" on" if on else "") + '"></span><span class="pn"><b>'
                    + name + "</b>" + t + "<small>" + path + '</small></span><span class="c">' + str(n) + "개</span></div>")
    return ("<h3>어느 프로젝트 폴더의 대화를 수집할까요?</h3><p class=\"lead\">고른 에이전트의 대화가 있는 폴더입니다.</p>"
            '<div class="pt">' + "".join(rows) + "</div>"
            '<div class="row2"><span class="box on"></span>새로 생기는 프로젝트 폴더도 수집</div>'
            '<div class="row2" style="color:#57534b">' + past + "</div>")


def w3_matrix(mine="이 컴퓨터 서버", mine_on=("honcho", "web-app", "api-server", "notes"), fresh=("honcho",),
              past="새로 고른 폴더의 지난 대화 33개도 회사에 쌓습니다."):
    """Project step when the server step picked more than one server: one column per server.
    The company column starts empty apart from what the user ticks (honcho here)."""
    head_row = ('<div class="pr m h"><span>폴더</span><span class="c">대화</span><span class="ch">' + mine + "</span>"
                '<span class="ch">회사 서버<br>' + tag("승인 요청", "warn") + "</span></div>")
    group = ('<div class="pr m h" style="padding-bottom:0;border-bottom:0"><span></span><span></span>'
             '<span style="grid-column:3 / -1;text-align:center;padding-bottom:6px;border-bottom:1px solid #d8d3c8;'
             'color:#57534b;font-weight:600">쌓을 곳</span></div>')
    rows = [group, head_row]
    for name, path, n in PROJECTS:
        company = name == "honcho"
        rows.append('<div class="pr m' + (" fresh" if name in fresh else "") + '"><span class="pn"><b>' + name + "</b><small>" + path
                    + '</small></span><span class="c">' + str(n) + '개</span><span class="cc"><span class="box'
                    + (" on" if name in mine_on else "") + '"></span></span>'
                    '<span class="cc"><span class="box' + (" on" if company else "") + '"></span></span></div>')
    rows.append('<div class="pr m"><span class="pn"><b>새로 생기는 폴더</b></span><span></span>'
                '<span class="cc"><span class="box on"></span></span><span class="cc"><span class="box"></span></span></div>')
    return ("<h3>어느 프로젝트 폴더의 대화를 수집할까요?</h3><p class=\"lead\">서버마다 쌓을 폴더를 고르세요. 고른 서버마다 칸이 하나씩 생깁니다.</p>"
            '<div class="pt">' + "".join(rows) + "</div>"
            '<div class="row2" style="color:#57534b">' + past + "</div>")


def progress(items):
    out = []
    for state, title, sub, extra in items:
        if state == "label":
            out.append('<div class="pgl">' + title + "</div>")
            continue
        icon = {"ok": '<span class="ic ok">✓</span>', "run": '<span class="ic run"></span>',
                "wait": '<span class="ic wait"></span>'}[state]
        out.append('<div class="pg' + (" wait" if state == "wait" else "") + '">' + icon + '<div class="pb"><div class="pgt">'
                   + title + "</div>" + ('<div class="pgs">' + sub + "</div>" if sub else "") + "</div>" + extra + "</div>")
    return '<div class="prog">' + "".join(out) + "</div>"


# A W4 list: the memory server's own steps first, then each agent's, then the teammates'.
SERVER_STEPS = ("label", "기억 서버", "", "")
AGENT_STEPS = ("label", "에이전트", "", "")
MATE_STEPS = [("label", "팀원", "", ""), ("wait", "alice와 bob에게 chat 요청", "", "")]
PROG_INSTALL = [
    SERVER_STEPS,
    ("ok", "Docker", "이 컴퓨터에 있음", ""),
    ("ok", "기억 서버 설치", "Honcho와 Ollama", ""),
    ("run", "ChatGPT 계정 로그인", "브라우저에서 로그인을 마치세요.", btn("브라우저 다시 열기", sm=True)),
    AGENT_STEPS,
    ("wait", "Claude Code에 플러그인 설치", "", ""),
    ("wait", "Codex에 플러그인 설치", "", ""),
    ("wait", "지난 대화 수집 시작", "", ""),
]
PROG_INSTALL_TWO = [
    SERVER_STEPS,
    ("ok", "Docker", "이 컴퓨터에 있음", ""),
    ("ok", "기억 서버 설치", "Honcho와 Ollama", ""),
    ("ok", "ChatGPT 계정 로그인 1/2", '<span class="mono">me@example.com</span>', ""),
    ("run", "ChatGPT 계정 로그인 2/2", "브라우저에서 다른 ChatGPT 계정으로 로그인하세요.", btn("브라우저 다시 열기", sm=True)),
    AGENT_STEPS,
    ("wait", "Claude Code에 플러그인 설치", "", ""),
    ("wait", "Codex에 플러그인 설치", "", ""),
    ("wait", "지난 대화 수집 시작", "", ""),
] + MATE_STEPS
PROG_CONNECT_GROK = [
    SERVER_STEPS,
    ("ok", "내 서버 연결", MY_SERVER, ""),
    AGENT_STEPS,
    ("ok", "Claude Code에 플러그인 설치", "", ""),
    ("run", "Codex에 플러그인 설치", "", ""),
    ("wait", "Grok CLI에 훅 설치", "", ""),
    ("wait", "ChatGPT 기록 가져오기", CHATGPT_FILE, ""),
    ("wait", "지난 대화 수집 시작", "", ""),
] + MATE_STEPS
PROG_CONNECT_COMPANY = [
    SERVER_STEPS,
    ("ok", "내 서버 연결", MY_SERVER, ""),
    ("ok", "회사 서버에 승인 요청", COMPANY + " · 승인 기다리는 중", ""),
    AGENT_STEPS,
    ("ok", "Claude Code에 플러그인 설치", "", ""),
    ("run", "Codex에 플러그인 설치", "", ""),
    ("wait", "지난 대화 수집 시작", "", ""),
] + MATE_STEPS
PROG_LAN = [
    SERVER_STEPS,
    ("ok", "서버 연결", LAN, ""),
    AGENT_STEPS,
    ("ok", "Claude Code에 플러그인 설치", "", ""),
    ("run", "Codex에 플러그인 설치", "", ""),
    ("wait", "지난 대화 수집 시작", "", ""),
]

TODO_AGENTS = [
    ("Claude Code", "열린 세션에 <span class=\"mono\">/reload-plugins</span> 를 입력하세요."),
    ("Codex", "새 세션을 열고 훅을 승인하세요."),
]
TODO_BELL = ("알림", "팀원이 승인하면 오른쪽 위 종에 알림이 뜹니다. 그 알림에서 연결을 누르세요.")


def todo(items):
    return '<ol class="todo">' + "".join("<li><div><b>" + a + "</b>" + b + "</div></li>" for a, b in items) + "</ol>"


# ---------------------------------------------------------------- screens
# Each returns (side_html, main_html, modal_html).

BLANK = (side("blank"), "")


def scr_start(hit):
    cards = [("팀에 들어가기", "관리자에게 받은 팀 주소로 Google에 로그인합니다.", "들어가기"),
             ("새 팀 만들기", "팀 관리자가 처음 한 번 합니다.", "만들기"),
             ("혼자 쓰기", "로그인과 팀 없이 내 컴퓨터에서만 씁니다.", "시작")]
    body = ("<h3>어떻게 시작할까요?</h3>" + '<div class="cards">' + "".join(
        '<div class="cardopt"><b>' + t + "</b><p>" + d + "</p>" + btn(b, hit=b == hit) + "</div>"
        for t, d, b in cards) + "</div>")
    return BLANK + (wizard(START, None, None, body, ""),)


def scr_team_addr():
    body = ('<h3>팀 주소를 넣으세요</h3><div class="field"><label>팀 주소</label><div class="input mono">' + TEAM_ADDR
            + "</div></div>")
    return BLANK + (wizard(START, JOIN, 0, body, foot(btn("이전", "quiet"), btn("Google로 로그인", "pri", hit=True))),)


def scr_team_make():
    body = ('<h3>새 팀 만들기</h3>'
            '<div class="field"><label>팀 이름</label><div class="input">예시 팀</div></div>'
            '<div class="field"><label>Cloudflare API token</label><div class="input mono">••••••••••••••••••••••••</div>'
            '<div class="hint">Cloudflare에서 만든 API token을 여기에만 붙여 넣으세요.</div></div>'
            '<div class="field"><label>관리자 Google 이메일</label><div class="input mono">admin@example.com</div></div>'
            '<div class="fold">▸ token 권한과 팀 주소</div>')
    return BLANK + (wizard(START, MAKE_NEW, 0, body, foot(btn("이전", "quiet"), btn("만들고 로그인", "pri", hit=True))),)


def scr_login(steps, at):
    body = ('<h3>브라우저에서 Google 로그인을 마치세요</h3>'
            '<div class="idbox"><b>예시 팀</b><span class="mono muted">' + TEAM_ADDR + "</span></div>"
            '<div class="waitline"><span class="spin"></span>로그인을 기다리는 중입니다.</div>'
            '<div class="hint">브라우저가 열리지 않았으면 브라우저 다시 열기를 누르세요.</div>')
    return BLANK + (wizard(START, steps, at, body, foot(btn("취소", "quiet"), btn("브라우저 다시 열기"))),)


def scr_not_in_list():
    body = ('<h3>이 이메일은 팀 명단에 없습니다</h3>'
            '<div class="idbox"><span class="mono">' + ME + "</span></div>"
            '<p class="lead" style="margin-top:12px">이 이메일을 팀 관리자에게 보내고, 등록되면 다시 로그인을 누르세요.</p>')
    return BLANK + (wizard(START, TEAM, 0, body,
                           foot(btn("다른 계정으로 로그인", "quiet"), btn("이메일 복사") + btn("다시 로그인", "pri"))),)


def scr_w1(steps, at, kind, back=False, company=False):
    left = btn("이전", "quiet") if back else ""
    return BLANK + (wizard(START, steps, at, w1_body(kind, company), foot(left, btn("다음", "pri", hit=True))),)


def scr_w2(steps, at, agents=AGENTS_FOUND, chatgpt=False):
    return BLANK + (wizard(START, steps, at, w2_body(agents=agents, chatgpt=chatgpt),
                           foot(btn("이전", "quiet"), btn("다음", "pri", hit=True))),)


def scr_w3(steps, at, body=None):
    last = "적용" if at == len(steps) - 1 else "다음"
    return BLANK + (wizard(START, steps, at, body or w3_body(), foot(btn("이전", "quiet"), btn(last, "pri", hit=True))),)


def scr_w4(steps, items):
    body = "<h3>설정하는 중입니다</h3>" + progress(items)
    return BLANK + (wizard(START, steps, "done", body, ""),)


def scr_w5(steps, items, button="대시보드 열기", title=None, lead=None):
    body = ("<h3>" + (title or "에이전트에서 할 일 " + str(len(items)) + "개") + "</h3>"
            + ('<p class="lead">' + lead + "</p>" if lead else "") + todo(items))
    return BLANK + (wizard(START, steps, "done", body, foot("", btn(button, "pri", hit=True))),)


def scr_wm(steps, at, accounts=1):
    count = '<span class="cnt-l">계정</span><span class="cnt"><i>−</i><b>' + str(accounts) + "</b><i>+</i></span>"
    body = ('<h3>기억 서버가 쓸 구독을 고르세요</h3><p class="lead">적용할 때 고른 계정마다 브라우저에서 로그인합니다.</p><div class="opts">'
            + opt("box", True, "ChatGPT 구독", end=count)
            + opt("box", False, "Claude 구독")
            + '</div><div class="hint">하나 이상 고르세요. 계정이 여럿이면 +를 누르세요.</div>')
    return BLANK + (wizard(START, steps, at, body, foot(btn("이전", "quiet"), btn("다음", "pri", hit=True))),)


def scr_wt(steps=CHATONLY):
    """Teammate step, the last step of every first setup that has teammates."""
    body = ('<h3>어느 팀원의 기억에 물을까요?</h3><div class="opts" style="margin-top:14px">'
            + opt("box", True, 'alice <span class="mono muted">memory-alice.example.com</span>')
            + opt("box", True, 'bob <span class="mono muted">memory-bob.example.com</span>')
            + opt("box", False, "carol", "서버 없음", dis=True)
            + '</div>')
    return BLANK + (wizard(START, steps, len(steps) - 1, body, foot(btn("이전", "quiet"), btn("적용", "pri", hit=True))),)


# in-app backdrops
def bg_settings(collect=COLLECT_BASE, toast=None, hit=None, kind="member"):
    return (side(kind, "기억 설정"), settings(collect, toast, hit))


def scr_edit(step, body, hit_step=None, hit_btn=None, collect=COLLECT_BASE):
    bg = bg_settings(collect)
    left = btn("취소", "quiet")
    if step == 0:
        right = btn("다음", "pri", hit=hit_btn == "다음")
    elif step == 1:
        right = btn("이전", "quiet") + btn("다음", "pri", hit=hit_btn == "다음")
    else:
        right = btn("이전", "quiet") + btn("적용", "pri", hit=hit_btn == "적용")
    return bg + (wizard(EDIT_TITLE, EDIT, step, body, foot(left, right), close=True, link=True, hit_step=hit_step),)


def page(kind, on, main, hit=None):
    return (side(kind, on, hit), main, "")


# ---------------------------------------------------------------- rows

ROWS = []


def cat(title):
    ROWS.append(("cat", title))


def case(cid, name, steps, end):
    ROWS.append(("case", cid, name, steps, end))


MATES_LATER = " 팀원이 승인한 뒤 연결은 4-1 줄 6번째 화면부터 같습니다."
DONE_GREEN = ("green", "끝. 대시보드 열기를 누르면 대시보드가 열립니다." + MATES_LATER)
DONE_LOCAL = ("green", "끝. 대시보드 열기를 누르면 대시보드가 열립니다 (3-1 줄 첫 화면과 같은 꼴)." + MATES_LATER)

cat("1. 처음 설정 · 팀 링크로 열었을 때 (링크를 열면 바로 Google 로그인)")
case("1-1", "이메일이 팀 명단에 없음", [
    ("L1", "로그인 중", scr_login(TEAM, 0)),
    ("L2", "명단에 없음", scr_not_in_list()),
], ("gray", "끝. 관리자가 이 이메일을 팀원으로 더하면 다시 로그인을 누릅니다."))
case("1-2", "내 서버가 이미 있음", [
    ("L1", "로그인 중", scr_login(TEAM, 0)),
    ("W1", "서버 · 찾은 내 서버", scr_w1(TEAM, 1, "found")),
    ("W2", "에이전트 · Grok CLI도 찾음 · ChatGPT 파일 고름", scr_w2(TEAM, 2, AGENTS_GROK, chatgpt=True)),
    ("W3", "프로젝트", scr_w3(TEAM, 3)),
    ("WT", "팀원 · 적용", scr_wt(TEAM)),
    ("W4", "적용 중", scr_w4(TEAM, PROG_CONNECT_GROK)),
    ("W5", "할 일", scr_w5(TEAM, TODO_AGENTS + [("Grok CLI", "새 세션을 여세요."), TODO_BELL], title="할 일 4개")),
], DONE_GREEN)
case("1-3", "내 서버 없음 · 이 컴퓨터에 만들기", [
    ("L1", "로그인 중", scr_login(TEAM, 0)),
    ("W1", "서버 · 새로 만들기 (모델 단계가 붙음)", scr_w1(TEAM_NEW, 1, "none")),
    ("WM", "모델 · ChatGPT 계정 2개", scr_wm(TEAM_NEW, 2, accounts=2)),
    ("W2", "에이전트", scr_w2(TEAM_NEW, 3)),
    ("W3", "프로젝트", scr_w3(TEAM_NEW, 4)),
    ("WT", "팀원 · 적용", scr_wt(TEAM_NEW)),
    ("W4", "적용 중 · 계정마다 로그인", scr_w4(TEAM_NEW, PROG_INSTALL_TWO)),
    ("W5", "할 일", scr_w5(TEAM_NEW, TODO_AGENTS + [TODO_BELL], title="할 일 3개")),
], DONE_LOCAL)
case("1-4", "내 서버 없음 · 쌓지 않고 팀원 기억만", [
    ("L1", "로그인 중", scr_login(TEAM, 0)),
    ("W1", "서버 · 쌓지 않기 (팀원 단계만 남음)", scr_w1(CHATONLY, 1, "skip")),
    ("WT", "팀원 · 적용", scr_wt()),
    ("W5", "승인 기다리는 중", scr_w5(CHATONLY, [TODO_BELL],
                               button="팀 화면 열기", title="승인 기다리는 중", lead="alice와 bob에게 chat 요청을 보냈습니다.")),
    ("T1", "팀 · 승인 기다리는 중", page("chat", "팀", team(
        mates=[item("alice", " " + tag("승인 기다리는 중", "warn"), "memory-alice.example.com", btn("요청 취소", "quiet", sm=True)),
               item("bob", " " + tag("승인 기다리는 중", "warn"), "memory-bob.example.com", btn("요청 취소", "quiet", sm=True)),
               MATE_CAROL]))),
], ("gray", "끝. 승인된 뒤 연결은 4-1 줄 6번째 화면부터 같습니다."))
case("1-5", "내 서버가 이미 있음 · 회사 서버에도 쌓기", [
    ("L1", "로그인 중", scr_login(TEAM, 0)),
    ("W1", "서버 · 회사도 고름", scr_w1(TEAM, 1, "found", company=True)),
    ("W2", "에이전트", scr_w2(TEAM, 2)),
    ("W3", "프로젝트 · 서버마다 고르기", scr_w3(TEAM, 3, w3_matrix(
        "내 서버", ("honcho", "web-app", "api-server"), fresh=(),
        past="고른 폴더의 지난 대화도 함께 쌓습니다 (내 서버 429개 · 회사 33개)."))),
    ("WT", "팀원 · 적용", scr_wt(TEAM)),
    ("W4", "적용 중 · 회사에 승인 요청", scr_w4(TEAM, PROG_CONNECT_COMPANY)),
    ("W5", "할 일", scr_w5(TEAM, TODO_AGENTS + [TODO_BELL], title="할 일 3개")),
], ("green", "끝. 회사 서버 주인이 승인하면 따로 누를 것 없이 회사에도 쌓입니다. 승인하는 쪽은 3-2 줄 5번째 화면부터 같습니다."
    + MATES_LATER))

cat("2. 처음 설정 · 팀 링크 없이 열었을 때")
case("2-1", "팀에 들어가기", [
    ("S1", "처음 화면", scr_start("들어가기")),
    ("S2", "팀 주소", scr_team_addr()),
    ("L1", "로그인 중", scr_login(JOIN, 1)),
], ("orange", "로그인 뒤는 1-1 ~ 1-4 줄과 같습니다. 단계 표시 맨 앞에 팀 주소가 붙어 있습니다."))
case("2-2", "새 팀 만들기 (관리자)", [
    ("S1", "처음 화면", scr_start("만들기")),
    ("S3", "새 팀 만들기", scr_team_make()),
    ("L1", "로그인 중", scr_login(MAKE_NEW, 1)),
    ("W1", "서버 · 새로 만들기", scr_w1(MAKE_NEW, 2, "none-admin")),
    ("WM", "모델", scr_wm(MAKE_NEW, 3)),
    ("W2", "에이전트", scr_w2(MAKE_NEW, 4)),
    ("W3", "프로젝트 · 적용", scr_w3(MAKE_NEW, 5)),
    ("W4", "적용 중 · 구독 계정 로그인", scr_w4(MAKE_NEW, PROG_INSTALL)),
    ("W5", "할 일", scr_w5(MAKE_NEW, TODO_AGENTS + [("관리자 탭", "팀원 더하기로 팀원 이메일을 넣고, 팀 주소를 보내세요.")],
                         button="관리자 탭 열기", title="할 일 3개")),
], ("green", "끝. 관리자 탭이 열립니다 (5-1 줄 첫 화면)."))
case("2-3", "혼자 쓰기 · 이 컴퓨터에 서버 만들기", [
    ("S1", "처음 화면", scr_start("시작")),
    ("W1", "서버 · 새로 만들기 (모델 단계가 붙음)", scr_w1(SOLO_NEW, 0, "solo-local", back=True)),
    ("WM", "모델", scr_wm(SOLO_NEW, 1)),
    ("W2", "에이전트", scr_w2(SOLO_NEW, 2)),
    ("W3", "프로젝트 · 적용", scr_w3(SOLO_NEW, 3)),
    ("W4", "적용 중 · 구독 계정 로그인", scr_w4(SOLO_NEW, PROG_INSTALL)),
    ("W5", "에이전트에서 할 일", scr_w5(SOLO_NEW, TODO_AGENTS)),
], ("green", "끝. 대시보드가 열립니다. 혼자 쓰기에는 팀 탭이 없습니다."))
case("2-4", "혼자 쓰기 · 다른 컴퓨터의 내 서버", [
    ("S1", "처음 화면", scr_start("시작")),
    ("W1", "서버 · 다른 컴퓨터", scr_w1(SOLO, 0, "solo-remote", back=True)),
    ("W2", "에이전트", scr_w2(SOLO, 1)),
    ("W3", "프로젝트 · 적용", scr_w3(SOLO, 2)),
    ("W4", "적용 중 · 서버 연결", scr_w4(SOLO, PROG_LAN)),
    ("W5", "에이전트에서 할 일", scr_w5(SOLO, TODO_AGENTS)),
], ("green", "끝. 대시보드가 열립니다. 혼자 쓰기에는 팀 탭이 없습니다."))

cat("3. 설정 바꾸기 · 메뉴 안의 설정은 모두 창으로 열림 · 대화 수집 설정은 처음 설정과 같은 창")
case("3-1", "대화 수집 설정 바꾸기", [
    ("D1", "대시보드", page("member", "대시보드", dashboard([ROW_LOCAL]), hit="기억 설정")),
    ("D2", "기억 설정", (side("member", "기억 설정"), settings(COLLECT_BASE, hit="collect"), "")),
    ("W1", "서버 (수정)", scr_edit(0, w1_body("edit"), hit_btn="다음")),
    ("W2", "에이전트 (수정)", scr_edit(1, w2_body(edit=True), hit_btn="다음")),
    ("W3", "프로젝트 · 적용 (수정)", scr_edit(2, w3_body(("honcho", "web-app", "api-server", "notes"), fresh=("notes",),
                                                       past="새로 고른 폴더의 지난 대화 14개도 함께 수집합니다."),
                                  hit_btn="적용")),
    ("D2", "기억 설정 · 적용 뒤", (side("member", "기억 설정"), settings(COLLECT_NOTES, toast="적용했습니다."), "")),
], ("gray", "끝. 수정 창은 처음 설정 창과 같습니다. 단계 이름을 눌러 바로 옮겨 갈 수도 있습니다."))
COMPANY_DASH = page("admin", "대시보드", dashboard([("on", "이 컴퓨터 서버", LOCAL, "최신", "0개", "1분 전", "52,118개")],
                                                 share=("켜짐", COMPANY)))
case("3-2", "회사 서버에도 쌓기", [
    ("D2", "기억 설정", (side("member", "기억 설정"), settings(COLLECT_NOTES, hit="collect"), "")),
    ("W1", "서버 · 회사 고름 (수정)", scr_edit(0, w1_body("edit-company"), hit_step=2, collect=COLLECT_NOTES)),
    ("W3", "프로젝트 · 서버마다 고르기 · 적용", scr_edit(2, w3_matrix(), hit_btn="적용", collect=COLLECT_NOTES)),
    ("D2", "기억 설정 · 승인 기다리는 중", (side("member", "기억 설정"),
                                       settings(COLLECT_COMPANY, toast="적용했습니다."), "")),
    ("D1", "회사 서버 주인 앱 · 대시보드", ring(COMPANY_DASH, hit=True)),
    ("N1", "회사 서버 주인 앱 · 알림", ring(COMPANY_DASH, items=[
        item("me의 MacBook", "", "honcho 폴더의 대화를 쌓으려 합니다 · 방금",
             btn("승인", "pri", sm=True, hit=True) + btn("거절", "danger", sm=True))])),
    ("D1", "내 대시보드 · 회사 줄 생김", page("member", "대시보드", dashboard(
        [ROW_LOCAL, ("warn", "회사", COMPANY, "동기화 중", "33개", "방금", "-")]))),
], ("green", "끝. 승인되면 따로 누를 것 없이 회사 서버에도 쌓이기 시작합니다."))
case("3-3", "MCP 도구 바꾸기", [
    ("D2", "기억 설정", (side("member", "기억 설정"), settings(COLLECT_BASE, hit="mcp"), "")),
    ("M1", "MCP 도구 창", bg_settings() + (simple("MCP 도구",
        '<div class="opts">'
        '<div class="swrow"><div class="ab"><div class="t">찾기 도구</div><div class="s">기억을 읽기만 하는 도구 20개</div></div><span class="switch on"></span></div>'
        '<div class="swrow"><div class="ab"><div class="t">바꾸기·지우기 도구</div><div class="s">기억을 바꾸거나 지우는 도구 11개</div><div class="s" style="color:#7d510c">켜면 에이전트가 기억을 바꾸거나 지울 수 있습니다.</div></div><span class="switch on"></span></div>'
        '</div><div class="fold">▸ 하나씩 켜고 끄기</div>'
        '<div class="hint" style="margin-top:12px">적용한 뒤 Claude Code는 <span class="mono">/reload-plugins</span> 를 입력하고, Codex는 새 세션을 여세요.</div>',
        foot("", btn("취소", "quiet") + btn("적용", "pri", hit=True))),)),
], ("gray", "끝. 적용하면 창이 닫히고 기억 설정의 MCP 도구 줄이 바뀝니다."))
case("3-4", "ChatGPT 기록 가져오기", [
    ("D2", "기억 설정", (side("member", "기억 설정"), settings(COLLECT_BASE, hit="import"), "")),
    ("M2", "ChatGPT 기록 창", bg_settings() + (simple("ChatGPT 기록 가져오기",
        '<p class="lead" style="margin-top:4px">ChatGPT의 설정 → 데이터 제어 → 데이터 내보내기로 받은 zip 파일을 고르세요.</p>'
        '<div class="file">' + btn("파일 고르기", sm=True) + '<span class="mono">chatgpt-export.zip</span><span class="muted" style="font-size:12.5px">48MB · 대화 312개</span></div>',
        foot("", btn("취소", "quiet") + btn("가져오기", "pri", hit=True))),)),
], ("gray", "끝. 가져오는 동안 창에 진행이 보이고, 끝나면 기억에 있는 대화 수가 바뀝니다."))
case("3-5", "내 다른 컴퓨터 끊기", [
    ("V1", "서버 → 공유", page("member", "서버", share_page(MY_SERVER, [
        item("이 컴퓨터", "", "3분 전에 쌓음"),
        item("iMac", " " + tag("내 컴퓨터"), "1시간 전에 쌓음", btn("끊기", "danger", sm=True)),
        item("Windows PC", " " + tag("내 컴퓨터"), "2시간 전에 쌓음", btn("끊기", "danger", sm=True, hit=True)),
    ]))),
    ("V2", "끊기 확인 창", (side("member", "서버"), share_page(MY_SERVER, [
        item("이 컴퓨터", "", "3분 전에 쌓음"),
        item("iMac", " " + tag("내 컴퓨터"), "1시간 전에 쌓음", btn("끊기", "danger", sm=True)),
        item("Windows PC", " " + tag("내 컴퓨터"), "2시간 전에 쌓음", btn("끊기", "danger", sm=True)),
    ]), simple("Windows PC를 끊을까요?",
               '<p class="lead" style="margin-top:4px">Windows PC는 이 서버에 더 이상 대화를 쌓지 못합니다. 다시 붙이려면 그 컴퓨터의 기억 설정에서 수정을 누르세요.</p>',
               foot("", btn("취소", "quiet") + btn("끊기", "dangerfill", hit=True))))),
], ("gray", "끝. 내 컴퓨터는 승인 없이 붙고, 끊을 때만 여기서 끊습니다."))
case("3-6", "백업 바꾸기", [
    ("B1", "백업", page("member", "백업", backup_page(hit="edit"))),
    ("B2", "백업 설정 창", (side("member", "백업"), backup_page(), simple("백업 설정",
        '<div class="label">백업할 곳</div><div class="opts">'
        + opt("radio", False, "폴더에 백업", "외장 드라이브나 NAS 폴더")
        + opt("radio", True, "클라우드에 백업", "rclone에 연결해 둔 클라우드(remote)",
              extra='<div class="sub" style="margin-left:0"><div class="field"><label>rclone remote</label><div class="input mono">gdrive ▾</div></div>'
                    '<div class="field"><label>그 안의 폴더</label><div class="input mono">대화</div></div></div>')
        + '</div><div class="label">자동 백업</div><div class="row2" style="margin-top:0"><span class="switch on"></span>매일'
          '<span class="input mono" style="height:32px;width:72px">04 ▾</span>:02</div>',
        foot("", btn("취소", "quiet") + btn("적용", "pri", hit=True))))),
], ("gray", "끝. 적용하면 창이 닫히고 백업 페이지의 글이 바뀝니다."))
case("3-7", "기억 서버가 쓰는 모델 바꾸기", [
    ("G1", "서버 → 모델", page("member", "서버", models_page(hit="model"))),
    ("G2", "모델 창", (side("member", "서버"), models_page(), simple("기억 서버가 쓰는 모델",
        '<p class="lead" style="margin-top:4px">구독 게이트웨이에 로그인한 계정의 모델입니다.</p><div class="opts">'
        + opt("radio", False, '<span class="mono">gpt-6.1-sol</span>', "ChatGPT", tag("지금 씀"))
        + opt("radio", True, '<span class="mono">claude-sonnet-5-5</span>', "Claude")
        + opt("radio", False, '<span class="mono">claude-haiku-4-5</span>', "Claude")
        + '</div><div class="row2">' + btn("써 보기", sm=True) + '<span class="muted" style="font-size:12.5px">claude-sonnet-5-5 · 답함 · 2.1초</span></div>',
        foot("", btn("취소", "quiet") + btn("적용", "pri", hit=True))))),
], ("gray", "끝. 계정 더하기도 같은 식으로 창이 열리고, 그 창에서 ChatGPT나 Claude로 로그인합니다."))

cat("4. 팀 · 팀원 기억에 묻기")
TEAM_A = [MATE_ALICE, MATE_DAVE, item("bob", "", "memory-bob.example.com", btn("chat 요청", sm=True, hit=True)), MATE_CAROL]
TEAM_B = [MATE_ALICE, MATE_DAVE, item("bob", " " + tag("승인 기다리는 중", "warn"), "방금 요청", btn("요청 취소", "quiet", sm=True)), MATE_CAROL]
TEAM_C = [MATE_ALICE, MATE_DAVE, item("bob", " " + tag("승인됨", "ok"), "열린 프로젝트 1개", btn("연결", "pri", sm=True)), MATE_CAROL]
TEAM_D = [MATE_ALICE, MATE_DAVE, item("bob", "", "Claude Code·Codex · 열린 프로젝트 1개", SWITCH_ON), MATE_CAROL]
BOB_MATES = [item("alice", "", "Claude Code · 열린 프로젝트 1개", SWITCH_ON),
             item("dave", "", "memory-dave.example.com", btn("chat 요청", sm=True)),
             item("me", "", MY_SERVER, btn("chat 요청", sm=True)), MATE_CAROL]
BOB_DASH = page("member", "대시보드", dashboard([ROW_LOCAL], share=("켜짐", "memory-bob.example.com")))
BOB_ASK = item("me", "", "내 기억에 chat으로 물으려 합니다 · 방금",
               btn("승인", "pri", sm=True, hit=True) + btn("거절", "danger", sm=True))
BOB_OK = item("bob", "", "chat 요청을 승인했습니다 · 열린 프로젝트 1개 · 방금", btn("연결", "pri", sm=True, hit=True))
BOB_PROJECTS = [("mobile-app", "~/dev/mobile-app", 58, True), ("design-system", "~/dev/design-system", 21, False),
                ("notes", "~/Documents/notes", 9, False)]


def project_boxes(rows):
    out = ['<div class="pr h"><span class="box"></span><span>폴더</span><span class="c">대화</span></div>']
    for name, path, n, on in rows:
        out.append('<div class="pr"><span class="box' + (" on" if on else "") + '"></span><span class="pn"><b>' + name
                   + "</b><small>" + path + '</small></span><span class="c">' + str(n) + "개</span></div>")
    return '<div class="pt">' + "".join(out) + "</div>"


case("4-1", "팀원 기억에 chat 요청 → 승인 → 연결", [
    ("T1", "팀 (내 앱)", page("member", "팀", team(mates=TEAM_A, granted=[GRANT_ALICE()]))),
    ("T1", "팀 · 요청 보냄 (내 앱)", page("member", "팀", team(mates=TEAM_B, granted=[GRANT_ALICE()]))),
    ("D1", "대시보드 (bob 앱)", ring(BOB_DASH, hit=True)),
    ("N1", "알림 (bob 앱)", ring(BOB_DASH, items=[BOB_ASK])),
    ("T2", "chat 승인 창 (bob 앱)", ring(BOB_DASH[:2] + (simple("me에게 내 기억 열기",
                                         '<p class="lead" style="margin-top:4px">me가 chat으로 물을 때 답에 쓸 프로젝트를 고르세요.</p>'
                                         + project_boxes(BOB_PROJECTS),
                                         foot("", btn("취소", "quiet") + btn("승인", "pri", hit=True))),))),
    ("N1", "알림 · bob이 승인함 (내 앱)", ring(page("member", "팀", team(mates=TEAM_C, granted=[GRANT_ALICE()])), items=[BOB_OK])),
    ("T3", "연결 창 (내 앱)", (side("member", "팀"), team(mates=TEAM_C, granted=[GRANT_ALICE()]),
                             simple("bob의 기억 연결",
                                    '<p class="lead" style="margin-top:4px">알림에서 연결을 눌러 bob의 기억을 이 컴퓨터의 Claude Code와 Codex에 도구로 넣었습니다. '
                                    "bob의 서버는 팀 Google 계정으로만 열려서, 에이전트마다 한 번 로그인하면 끝납니다.</p>"
                                    '<div class="opts">'
                                    '<div class="agent"><span class="src">C</span><div class="ab"><div class="t">Claude Code ' + tag("로그인 필요", "warn")
                                    + '</div><div class="s">열린 세션에서 <span class="mono">/mcp</span> 를 열고 <span class="mono">team-bob</span> 을 골라 Authenticate를 누르고, 브라우저가 열리면 팀 Google 계정으로 로그인하세요.</div></div></div>'
                                    '<div class="agent"><span class="src x">X</span><div class="ab"><div class="t">Codex ' + tag("로그인 필요", "warn")
                                    + '</div><div class="s">Codex 로그인을 누르고, 브라우저가 열리면 팀 Google 계정으로 로그인하세요.</div></div>'
                                    + btn("Codex 로그인", sm=True, hit=True) + "</div></div>",
                                    foot("", btn("닫기"))))),
    ("T1", "팀 · 연결됨 (내 앱)", page("member", "팀", team(mates=TEAM_D, granted=[GRANT_ALICE()]))),
], ("green", "끝. 에이전트가 bob 기억의 chat 도구로 묻고, bob이 연 프로젝트의 대화에서만 답을 받습니다. 잠시 끄려면 bob 줄의 스위치를 끕니다."))
case("4-2", "내 기억을 연 팀원 바꾸기", [
    ("T1", "팀", page("member", "팀", team(mates=[m.replace(" hit", "") for m in TEAM_A], granted=[GRANT_ALICE(hit=True)]))),
    ("T4", "연 프로젝트 창", (side("member", "팀"), team(mates=[m.replace(" hit", "") for m in TEAM_A], granted=[GRANT_ALICE()]),
                           simple("alice에게 연 프로젝트",
                                  '<p class="lead" style="margin-top:4px">alice가 chat으로 물을 때 답에 쓸 프로젝트입니다.</p>'
                                  + project_boxes([(n, p, c, n in ("honcho", "web-app", "api-server")) for n, p, c in PROJECTS]),
                                  foot(btn("alice 끊기", "danger"), btn("취소", "quiet") + btn("적용", "pri", hit=True))))),
], ("gray", "끝. 적용하면 alice에게 api-server가 더 열립니다. alice를 끊는 것도 이 창에 있습니다."))

cat("5. 관리자 탭 · 관리자에게만 보임")
case("5-1", "팀원 더하기", [
    ("A1", "관리자", tall(page("admin", "관리자", admin_page(members(), hit="add")))),
    ("A2", "팀원 더하기 창", tall((side("admin", "관리자"), admin_page(members()), simple("팀원 더하기",
        '<div class="field" style="margin-top:4px"><label>Google 이메일</label><div class="input mono">erin@example.com</div></div>'
        '<div class="notice warn" style="margin-top:14px">더한 사람은 팀 주소로 로그인해 팀원 명단과 서버 주소를 보고, 팀원 기억에 chat을, 회사 서버에 대화 쌓기를 요청할 수 있습니다. 회사 밖 사람은 더하지 마세요.</div>',
        foot("", btn("취소", "quiet") + btn("더하기", "pri", hit=True)))))),
    ("A1", "관리자 · 한 줄 늘어남", tall(page("admin", "관리자", admin_page(members(erin=True))))),
], ("gray", "끝. 페이지에는 이메일 한 줄만 늘어납니다. 팀 주소는 위의 복사로 erin에게 보냅니다."))
case("5-2", "팀에서 빼기", [
    ("A1", "관리자", tall(page("admin", "관리자", admin_page(members(hit_bob=True))))),
    ("A3", "빼기 확인 창", tall((side("admin", "관리자"), admin_page(members()), simple("bob을 팀에서 뺄까요?",
        '<p class="lead" style="margin-top:4px">bob@example.com 은 팀 주소로 로그인하지 못합니다. 팀원 기억 연결이 끊기고, 회사 서버에도 더 이상 대화를 쌓지 못합니다.</p>',
        foot("", btn("취소", "quiet") + btn("빼기", "dangerfill", hit=True)))))),
], ("gray", "끝."))


# ---------------------------------------------------------------- case map

CODES = [
    ("S1", "처음 화면 (세 갈래)"), ("S2", "팀 주소"), ("S3", "새 팀 만들기"), ("L1", "로그인 중"), ("L2", "명단에 없음"),
    ("W1", "서버 단계"), ("WM", "모델 단계"), ("W2", "에이전트 단계"), ("W3", "프로젝트 단계 · 적용"), ("WT", "팀원 단계 · 적용"),
    ("W4", "적용 중"), ("W5", "할 일"), ("D1", "대시보드"), ("D2", "기억 설정"), ("M1", "MCP 도구 창"),
    ("M2", "ChatGPT 기록 창"), ("N1", "알림 (종)"), ("T1", "팀"), ("T2", "chat 승인 창"), ("T3", "연결 창"), ("T4", "연 프로젝트 창"),
    ("V1", "서버 → 공유"), ("V2", "끊기 확인 창"), ("B1", "백업"), ("B2", "백업 설정 창"), ("G1", "서버 → 모델"),
    ("G2", "모델 창"), ("A1", "관리자"), ("A2", "팀원 더하기 창"), ("A3", "빼기 확인 창"),
]

RULES = [
    "처음 설정은 창 하나에서 끝납니다. 처음 고른 것(팀 링크 · 팀에 들어가기 · 새 팀 만들기 · 혼자 쓰기)에 따라 단계가 정해지고, 건너뛸 수 없습니다.",
    "단계는 서버 → 에이전트 → 프로젝트 → 팀원이고, 팀원은 팀원이 있는 팀에만 붙습니다. 마지막 단계에 적용이 있고, 확인 화면은 따로 없습니다.",
    "서버 단계에서 고른 것이 뒤 단계를 정합니다. 새로 만들기를 고르면 모델(구독 계정) 단계가 붙고, 쌓지 않기를 고르면 팀원 단계만 남습니다.",
    "설치가 끝난 뒤 기억 설정의 수정은 같은 창을 같은 단계로 엽니다. 회사 서버도 이 창의 서버 단계에서 고릅니다.",
    "메뉴 안의 설정은 모두 창으로 열립니다. 페이지는 지금 상태를 글로 보여 주고, 연결한 팀원 기억만 줄의 스위치로 바로 켜고 끕니다.",
    "알림은 오른쪽 위 종에만 모입니다. 받은 요청이나 승인된 내 요청처럼 내가 눌러야 할 것만 들어가고, 처리하면 사라집니다.",
    "팀원 명단과 팀원 더하기는 관리자 탭에만 있습니다. 팀원은 Cloudflare라는 말을 보지 않습니다.",
    "쌓지 않기를 고른 사람의 메뉴에는 기억 · 서버 탭이 없습니다. 기억 설정의 수정에서 서버를 고르면 생깁니다.",
    "팀으로 쓸 때 peer 이름은 Google 이메일의 @ 앞부분이라 묻지 않습니다. 혼자 쓰기만 직접 넣습니다.",
    "에이전트 단계는 찾은 에이전트 폴더를 한 줄씩 보여 줍니다. ChatGPT 기록은 여기서 내보내기 파일을 골라 지난 대화보다 먼저 가져옵니다.",
    "구독 계정이 여럿이면 모델 단계에서 수를 늘리고, 적용 중에 계정마다 로그인합니다.",
    "서버를 여럿 고르면 프로젝트 단계가 서버마다 열이 있는 표로 바뀝니다 (1-5, 3-2 줄). 함께 쌓을 서버의 열은 비어 있고, 고른 폴더만 그 서버에 쌓입니다.",
    "고른 폴더의 지난 대화는 적용할 때 모두 수집하고, 그 뒤 새 대화는 자동으로 쌓입니다.",
    "서버에 넣는 쪽은 '쌓다', 에이전트와 폴더에서 가져오는 쪽은 '수집'이라고 씁니다.",
    "적용 뒤 알림은 화면 아래에 떴다가 사라지고 페이지를 밀지 않습니다. 적용 중 목록도 줄 높이가 그대로입니다.",
    "주황 테두리는 다음 화면으로 가려고 누르는 곳입니다.",
]


def case_map():
    cols = []
    current = None
    for row in ROWS:
        if row[0] == "cat":
            current = {"title": row[1], "cases": []}
            cols.append(current)
        else:
            _, cid, name, steps, _end = row
            current["cases"].append((cid, name, " → ".join(code for code, _l, _s in steps)))
    col_html = ""
    for col in cols:
        chips = "".join('<div class="chip"><div class="cid">' + cid + '</div><div class="cb"><b>' + name
                        + '</b><div class="path">' + path + "</div></div></div>" for cid, name, path in col["cases"])
        col_html += '<div class="col"><h2>' + col["title"] + "</h2>" + chips + "</div>"
    codes = "".join('<div class="code"><b>' + c + "</b>" + n + "</div>" for c, n in CODES)
    rules = "".join("<li>" + r + "</li>" for r in RULES)
    css = """
*{box-sizing:border-box}
body{margin:0}
.map{width:2400px;height:""" + str(MAP_H) + """px;background:#faf8f4;font-family:'Noto Sans KR',sans-serif;color:#1d1c19;padding:56px 64px}
.map h1{margin:0;font-size:40px;font-weight:700}
.map .lead{margin:10px 0 0;color:#6f6a60;font-size:20px}
.top{display:flex;gap:28px;margin-top:30px}
.rules{flex:1.4;background:#fff;border:1px solid #e3dfd6;border-radius:16px;padding:22px 28px}
.rules b,.codes-box b.h{font-size:19px}
.rules ol{margin:12px 0 0;padding-left:24px;font-size:17px;line-height:1.7;color:#3a3732}
.codes-box{flex:1;background:#fff;border:1px solid #e3dfd6;border-radius:16px;padding:22px 28px}
.codes{display:grid;grid-template-columns:repeat(3,1fr);gap:6px 18px;margin-top:12px}
.code{font-size:15px;color:#3a3732}
.code b{display:inline-block;width:38px;color:#b5412a}
.cols{display:grid;grid-template-columns:repeat(5,1fr);gap:20px;margin-top:30px}
.col h2{margin:0 0 12px;font-size:18px;font-weight:700;line-height:1.35;min-height:50px}
.chip{display:flex;gap:12px;background:#fff;border:1px solid #e3dfd6;border-radius:12px;padding:14px 16px;margin-bottom:12px}
.cid{font-size:18px;font-weight:700;color:#b5412a;flex:none;width:40px}
.cb b{font-size:16px;font-weight:600}
.path{margin-top:6px;font-family:ui-monospace,Menlo,monospace;font-size:13.5px;color:#57534b;line-height:1.5}
"""
    html_body = ('<div class="map"><h1>경우의 수 지도</h1><p class="lead">줄 하나가 경우 하나입니다. 같은 화면도 줄마다 다시 그렸습니다. '
                 "보드 제목은 \"줄 번호 · 순서/개수 코드 이름\"입니다.</p>"
                 '<div class="top"><div class="rules"><b>이번 판의 규칙</b><ol>' + rules + "</ol></div>"
                 '<div class="codes-box"><b class="h">화면 코드</b><div class="codes">' + codes + "</div></div></div>"
                 '<div class="cols">' + col_html + "</div></div>")
    return css, html_body


# ---------------------------------------------------------------- write

def write_board(fname, title, side_html, main_html, modal_html, w=BW, h=BH, css=CSS, raw=None):
    if raw is None:
        inner = ('<div class="app" style="height:' + str(h) + 'px">' + side_html + '<div class="main">' + main_html
                 + "</div>" + modal_html + "</div>")
    else:
        inner = raw
    doc = ("<!doctype html>\n<html lang=\"ko\">\n<head>\n<meta charset=\"utf-8\">\n<title>" + title
           + "</title>\n<script src=\"./support.js\"></script>\n</head>\n<body>\n<x-dc>\n<helmet>\n" + FONTS
           + "\n<style>" + css + "</style>\n</helmet>\n" + inner + "\n</x-dc>\n"
           "<script type=\"text/x-dc\" data-dc-script data-props='{\"$preview\":{\"width\":" + str(w) + ",\"height\":" + str(h)
           + "}}'>\nclass Component extends DCLogic {\n  renderVals() {\n    return {};\n  }\n}\n</script>\n</body>\n</html>\n")
    with open(os.path.join(OUT, fname), "w") as f:
        f.write(doc)


def main():
    os.makedirs(OUT, exist_ok=True)
    canvas_path = os.path.join(OUT, "canvas.json")
    old_canvas = json.load(open(canvas_path)) if os.path.exists(canvas_path) else NEW_CANVAS
    for f in os.listdir(OUT):
        if f.endswith(".dc.html"):
            os.remove(os.path.join(OUT, f))
    boards, notes, order = {}, {}, []
    css, body = case_map()
    write_board("CaseMap.dc.html", "경우의 수 지도", "", "", "", 2400, MAP_H, css, raw=body)
    boards["CaseMap.dc.html"] = {"h": MAP_H, "title": "경우의 수 지도", "w": 2400, "x": 0, "y": 0}
    order.append("CaseMap.dc.html")
    notes["title"] = {"kind": "title1", "maxW": 6000, "text": "팀 메모리 화면 시안 · 처음 설정과 수정은 같은 창", "w": 240, "x": 0, "y": -260}
    y = MAP_H + 360
    cat_i = 0
    for row in ROWS:
        if row[0] == "cat":
            cat_i += 1
            notes["cat" + str(cat_i)] = {"kind": "title1", "maxW": 8000, "text": row[1], "w": 240, "x": 0, "y": y}
            y += 260
            continue
        _, cid, name, steps, end = row
        n = len(steps)
        row_h = BH
        for k, (code, label, screen) in enumerate(steps, 1):
            fname = cid + "_" + str(k) + "_" + code + ".dc.html"
            side_html, main_html, modal_html = screen[:3]
            bh = screen[3] if len(screen) > 3 else BH
            row_h = max(row_h, bh)
            title = (cid + " " + name + " · " if k == 1 else cid + " · ") + str(k) + "/" + str(n) + " " + code + " " + label
            write_board(fname, title, side_html, main_html, modal_html, h=bh)
            boards[fname] = {"h": bh, "title": title, "w": BW, "x": (k - 1) * PITCH_X, "y": y}
            order.append(fname)
        fill, text = end
        notes["end" + cid.replace("-", "")] = {"text": text, "w": 320, "fill": fill, "x": n * PITCH_X, "y": y}
        y += row_h + 220
    canvas = dict(old_canvas)
    canvas["boards"] = boards
    canvas["notes"] = notes
    canvas["order"] = order
    with open(canvas_path, "w") as f:
        json.dump(canvas, f, ensure_ascii=False, indent=2)
    print(len(boards), "boards;", len(notes), "notes; height", y)


if __name__ == "__main__":
    main()
