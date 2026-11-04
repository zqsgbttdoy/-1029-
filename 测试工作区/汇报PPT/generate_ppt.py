# -*- coding: utf-8 -*-
# 生成《监理现场管理系统-开发汇报.pptx》（带真实功能截图版）
# 每个功能一页：左侧真实界面大图 + 右侧功能要点/关联限制；另含技术栈、流程、关联机制、进展等。
import sys, os
BASE = r"e:\希地工作\trae 文件保存\完整版-监理 - qoder"
sys.path.insert(0, os.path.join(BASE, r"测试工作区\_pylibs"))
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE
from pptx.oxml.ns import qn, nsdecls
from pptx.oxml import parse_xml

OUT = os.path.join(BASE, "监理现场管理系统-开发汇报.pptx")
FRAMES = os.path.join(BASE, r"测试工作区\录屏汇报-核心全流程\frames")
def frame(i): return os.path.join(FRAMES, "frame-%02d.jpg" % i)

NAVY   = RGBColor(0x1F,0x3B,0x73); ACCENT = RGBColor(0x25,0x63,0xEB)
ORANGE = RGBColor(0xE0,0x6A,0x2B); INK = RGBColor(0x22,0x2B,0x3A)
MUTED  = RGBColor(0x5A,0x66,0x78); CARD = RGBColor(0xF1,0xF5,0xFB)
CARD2  = RGBColor(0xEA,0xF0,0xFA); WHITE = RGBColor(0xFF,0xFF,0xFF)
LINE   = RGBColor(0xC9,0xD4,0xE6); GREEN = RGBColor(0x1E,0x8E,0x5A)
FONT = "微软雅黑"

prs = Presentation(); prs.slide_width=Inches(13.333); prs.slide_height=Inches(7.5)
BLANK = prs.slide_layouts[6]

def _font(run,size,bold,color,italic=False):
    f=run.font; f.size=Pt(size); f.bold=bold; f.italic=italic; f.color.rgb=color; f.name=FONT
    rPr=run._r.get_or_add_rPr()
    for tag in ('a:latin','a:ea','a:cs'):
        e=rPr.find(qn(tag))
        if e is None:
            e=parse_xml('<%s %s typeface="%s"/>'%(tag,nsdecls('a'),FONT)); rPr.append(e)
        else: e.set('typeface',FONT)

def tb(slide,x,y,w,h,anchor=MSO_ANCHOR.TOP):
    box=slide.shapes.add_textbox(Inches(x),Inches(y),Inches(w),Inches(h))
    tf=box.text_frame; tf.word_wrap=True; tf.vertical_anchor=anchor
    tf.margin_left=0; tf.margin_right=0; tf.margin_top=0; tf.margin_bottom=0
    return tf

def para(tf,text,size=13,bold=False,color=INK,first=False,align=PP_ALIGN.LEFT,space_after=4,bullet=False,line=1.12):
    p=tf.paragraphs[0] if first else tf.add_paragraph()
    p.alignment=align; p.space_after=Pt(space_after); p.line_spacing=line
    r=p.add_run(); r.text=("• "+text) if bullet else text; _font(r,size,bold,color); return p

def rect(slide,x,y,w,h,fill,line_color=None,shape=MSO_SHAPE.RECTANGLE):
    sp=slide.shapes.add_shape(shape,Inches(x),Inches(y),Inches(w),Inches(h))
    sp.fill.solid(); sp.fill.fore_color.rgb=fill
    if line_color is None: sp.line.fill.background()
    else: sp.line.color.rgb=line_color; sp.line.width=Pt(0.75)
    sp.shadow.inherit=False; return sp

def title_bar(slide,text,sub=None):
    tf=tb(slide,0.62,0.42,12.1,0.85); para(tf,text,29,True,NAVY,first=True,space_after=0)
    if sub:
        tf2=tb(slide,0.64,1.12,12.0,0.4); para(tf2,sub,13,False,MUTED,first=True,space_after=0)
    rect(slide,0.64,1.5 if sub else 1.18,1.15,0.045,ACCENT)

def card(slide,x,y,w,h,head,items,head_color=NAVY,fill=CARD,size=12.3,bullet=True):
    rect(slide,x,y,w,h,fill,shape=MSO_SHAPE.ROUNDED_RECTANGLE)
    tf=tb(slide,x+0.24,y+0.2,w-0.48,h-0.4)
    para(tf,head,15,True,head_color,first=True,space_after=8)
    for it in items: para(tf,it,size,False,INK,bullet=bullet,space_after=5)

def section(slide,x,y,w,head,items,head_color=NAVY,size=12.8,gap=5):
    tf=tb(slide,x,y,w,0.4); para(tf,head,15.5,True,head_color,first=True,space_after=0)
    tf2=tb(slide,x,y+0.42,w,1.6)
    for i,it in enumerate(items): para(tf2,it,size,False,INK,first=(i==0),bullet=True,space_after=gap)

def new_slide(): return prs.slides.add_slide(BLANK)

# 功能展示页：左大图 + 右要点
def feature_slide(title,subtitle,img,points,notes):
    s=new_slide(); title_bar(s,title,subtitle)
    rect(s,0.55,1.72,8.34,5.34,WHITE,line_color=LINE)          # 图片底衬边框
    s.shapes.add_picture(img,Inches(0.62),Inches(1.8),width=Inches(8.2))
    cap=tb(s,0.62,6.98,8.2,0.3); para(cap,"▲ 系统真实运行界面",11,False,MUTED,first=True)
    tf=tb(s,9.05,1.85,3.72,0.4); para(tf,"功能要点",15.5,True,NAVY,first=True)
    tf2=tb(s,9.05,2.3,3.72,2.5)
    for i,p in enumerate(points): para(tf2,p,12.3,False,INK,first=(i==0),bullet=True,space_after=7)
    if notes:
        tf3=tb(s,9.05,4.95,3.72,0.4); para(tf3,"关联 / 限制",15,True,ORANGE,first=True)
        tf4=tb(s,9.05,5.4,3.72,1.6)
        for i,n in enumerate(notes): para(tf4,n,12,False,INK,first=(i==0),bullet=True,space_after=6)
    return s

# ============ 1 封面 ============
s=new_slide(); rect(s,0,0,13.333,7.5,NAVY); rect(s,0,0,13.333,0.22,ACCENT)
rect(s,9.4,2.0,3.93,5.5,RGBColor(0x27,0x49,0x86)); rect(s,9.4,2.0,0.08,5.5,ORANGE)
tf=tb(s,0.9,2.0,8.2,2.6)
para(tf,"监理现场管理系统",48,True,WHITE,first=True,space_after=14)
para(tf,"开发阶段汇报 · 功能介绍 · 技术架构 · 使用流程",19,False,RGBColor(0xC9,0xD8,0xF2))
tf2=tb(s,0.9,5.1,8.2,0.5); para(tf2,"面向工程监理现场的信息化管理平台",15,False,RGBColor(0xA9,0xBE,0xE6),first=True)
rect(s,0.9,5.85,7.6,0.02,RGBColor(0x3A,0x57,0x8C))
tf3=tb(s,0.9,6.15,11.5,0.9)
para(tf3,"当前状态：已初步开发完成，仍需大量测试与真实业务探索操作",15,True,ORANGE,first=True)
para(tf3,"PC 网页 + 微信小程序 三端同源 ｜ 汇报人：开发组",12.5,False,RGBColor(0xA9,0xBE,0xE6))

# ============ 2 定位 ============
s=new_slide(); title_bar(s,"系统定位与汇报说明","覆盖监理现场全业务：项目与组织 → 资料目录 → 现场记录 → 审核留痕 → 统计分析")
card(s,0.62,1.75,6.0,2.5,"系统是什么",["面向工程监理现场的一体化信息管理系统","管理对象：项目、组织人员、工程资料、现场记录","业务闭环：填报 → 提交 → 审核 → 留痕 → 统计追溯","三端同源：PC 网页端 + 微信小程序端"],size=13)
card(s,6.85,1.75,5.85,2.5,"本次汇报范围",["技术架构：前端语言、后端语言、数据库","核心使用流程与功能地图","各功能模块：真实界面 + 用法 / 限制 / 字段 / 关联","当前进展、已知限制与下一步计划"],size=13)
rect(s,0.62,4.55,12.08,2.15,RGBColor(0xFD,0xF3,0xE7),shape=MSO_SHAPE.ROUNDED_RECTANGLE)
tf=tb(s,0.92,4.8,11.5,1.75)
para(tf,"重要声明",16,True,ORANGE,first=True,space_after=8)
para(tf,"系统目前已初步开发完成，核心功能可运行，并已通过自动化回归与真实浏览器验收；",13.5,False,INK,bullet=True)
para(tf,"但仍需大量测试与真实业务探索操作，生产环境部署、数据库迁移与小程序真机验收尚未完成，",13.5,False,INK,bullet=True)
para(tf,"在正式对外使用前，应结合实际项目业务进行充分验证。",13.5,False,INK,bullet=True)

# ============ 3 技术架构 ============
s=new_slide(); title_bar(s,"技术架构","前端语言 / 后端语言 / 数据库 / 构建与部署")
card(s,0.62,1.75,3.95,4.4,"前端",["语言：HTML5 + JavaScript + CSS","形态：纯静态页面，无前端框架","共用引擎：field-records.js 统一记录弹窗","样式：field-records.css / responsive.css","移动端：微信小程序（WXML/WXSS/JS）","三端字段口径同源：utils/schema.js"],size=12.5)
card(s,4.69,1.75,3.95,4.4,"后端",["语言：Java 17","框架：Spring Boot 3.2.5","数据访问：Spring Data JPA","接口风格：REST API（JSON）","核心服务：FieldRecordService 状态机、","SubItemDatabaseService 目录树、","AttachmentAccessService 附件鉴权"],size=12.5)
card(s,8.76,1.75,3.95,4.4,"数据库",["正式库：MySQL 8.0","本地/测试：H2（文件库 / 内存库）","建表脚本：schema.sql","记录工作流：schema-field-workflow.sql","附件目录等以 JSON/TEXT 列存储","乐观锁：lock_version 字段"],size=12.5)
rect(s,0.62,6.35,12.08,0.75,CARD2,shape=MSO_SHAPE.ROUNDED_RECTANGLE)
tf=tb(s,0.92,6.5,11.5,0.5); para(tf,"构建与部署：Maven 打包为可执行 jar；Nginx 反向代理实现内网零成本部署；本地一键启动/停止脚本。",13,False,INK,first=True)

# ============ 4 核心流程 ============
s=new_slide(); title_bar(s,"核心使用流程","从建项目到留痕追溯的标准业务动线")
steps=[("1","登录与授权","统一账号登录\n按角色与项目授权"),("2","建项目与组织","项目台账建档\n人员/部门/权限"),("3","建资料目录","单位→分部→分项\n形成目录骨架"),("4","现场填报","日记/日志/巡检\n附件关联目录"),("5","提交审核留痕","提交→审核→驳回\n冻结并出新版本"),("6","统计与追溯","报表/统计\n消息与操作日志")]
x=0.62; w=1.92; gap=0.06
for i,(num,t,d) in enumerate(steps):
    cx=x+i*(w+gap); rect(s,cx,2.0,w,3.2,CARD,shape=MSO_SHAPE.ROUNDED_RECTANGLE)
    circ=rect(s,cx+w/2-0.32,2.25,0.64,0.64,ACCENT,shape=MSO_SHAPE.OVAL)
    ctf=circ.text_frame; p=ctf.paragraphs[0]; p.alignment=PP_ALIGN.CENTER; r=p.add_run(); r.text=num; _font(r,24,True,WHITE)
    tf=tb(s,cx+0.12,3.1,w-0.24,1.9); para(tf,t,15,True,NAVY,first=True,align=PP_ALIGN.CENTER,space_after=8)
    for ln in d.split("\n"): para(tf,ln,12,False,MUTED,align=PP_ALIGN.CENTER,space_after=3)
tf=tb(s,0.62,5.55,12.08,1.2)
para(tf,"要点：目录是附件关联的前置——须先在“工程资料目录设置”建好末级目录；记录提交后进入审核留痕，",13,False,INK,first=True,bullet=True)
para(tf,"驳回即冻结原件并生成独立新版本（V2/V3…），全过程可追溯。",13,False,INK,bullet=True)

# ============ 5 功能地图 ============
s=new_slide(); title_bar(s,"功能地图","四大功能域，覆盖监理现场管理全场景（后续逐页展示真实界面）")
card(s,0.62,1.75,6.0,2.35,"项目管理",["项目台账：在建项目建档与状态","人员管理 / 部门管理：组织与档案","权限设置：角色与数据授权"],size=12.8)
card(s,6.85,1.75,5.85,2.35,"项目资料",["工程资料目录设置：目录树骨架","工程资料上传：按目录归档","附件与目录关联（各记录表单共用）"],size=12.8)
card(s,0.62,4.3,6.0,2.5,"现场记录",["日常巡检 / 旁站检查（免审核备忘）","监理日记 / 监理日志 / 安全日志","会议纪要 / 监理月报 / 工作联系单","监理通知单（关联监理日记）"],size=12.8)
card(s,6.85,4.3,5.85,2.5,"数据与审计",["日记报表 / 日记统计 / 日志统计","安全日志统计：隐患与整改","消息中心 / 操作日志 / 流程管理","工作标准配置：统一填报口径"],size=12.8)

# ============ 功能展示（每功能一页，真实截图） ============
FEATURES=[
 ("工作台总览","登录后的统一工作入口",1,
  ["在建项目、待办事项、当日现场记录一屏总览","快捷入口：写日记 / 发起巡检 / 旁站 / 发通知单","最近监理日记与消息中心并列呈现"],
  ["数据按当前账号的项目权限聚合","首页即工作台，登录后直达"]),
 ("项目台账","在建项目建档与状态管理",2,
  ["集中管理所有在建监理项目","维护工程概况、建设/施工单位、总监与状态","支持新建、编辑与查询"],
  ["记录、资料、人员均归属项目","未授权项目对当前账号不可见"]),
 ("人员管理","监理人员档案与角色",3,
  ["登记监理人员信息、所属部门与岗位角色","作为授权、派工与记录人的基础数据"],
  ["与部门、权限设置联动","人员归属影响数据可见范围"]),
 ("部门管理","组织架构维护",4,
  ["维护部门层级与负责人","支撑人员归属与权限划分"],
  ["与人员管理、权限设置联动"]),
 ("权限设置","角色与数据权限",5,
  ["按角色配置功能权限与项目数据权限","控制“谁能看哪个项目、能做什么”"],
  ["精细化授权，保障项目间数据隔离"]),
 ("工程资料目录设置","附件归档与目录关联的标准骨架（核心前置）",6,
  ["按“单位工程→分部→分项”建立目录树","是各记录附件“所属目录”的唯一数据源","支持新增、编辑、停用目录节点"],
  ["仅末级（叶子）目录可被附件绑定","须先建目录，附件区才有候选"]),
 ("工程资料上传","按目录归档工程文件",7,
  ["选择项目与目录节点后上传文件","资料按目录分类留存、便于检索调阅"],
  ["附件须真实上传，伪造URL会被拒","绑定项目后不可跨项目复用"]),
 ("监理日记","每日施工现场情况记录",9,
  ["选项目后新建，自动带入工程名称与当天日期","按14项填写规范逐栏填写，可存草稿或提交","支持现场照片、附件上传与导出"],
  ["提交审核前须至少上传一张现场照片","作为监理日志的预填数据来源"]),
 ("监理日志","按九项规范记录施工与安全监理活动",10,
  ["九项规范：气象/施工部位/巡视/安全问题/重大事项等","新建时自动预填同项目当日已审核日记","支持保存草稿与提交审核"],
  ["预填仅填空白，不覆盖手工录入","填写人应由项目安全监理工程师负责"]),
 ("监理安全日志","安全巡视与隐患记录，支持目录关联与版本留痕",12,
  ["按九项规范记录安全监理内容","上传附件时可选择“所属工程资料目录”","驳回后可创建 V2/V3 独立修订版本"],
  ["附件目录须先建末级目录","驳回版本冻结，不可直接覆盖"]),
 ("会议纪要","工地例会与专题会议记录",14,
  ["登记会议主题、时间、内容与参会人","支持附件上传并绑定工程资料目录","草稿保存与提交"],
  ["会议编号需唯一","可作为日志/通知单的附件来源"]),
 ("监理月报","按月汇总监理工作报告",15,
  ["按月汇总项目监理工作情况","形成对建设单位的正式报告","支持附件与目录关联"],
  ["报告月份与编号需规范填写"]),
 ("工作联系单","参建各方日常沟通",17,
  ["填写编号、接收单位、日期与内容","草稿保存后可发送并留痕","附件可绑定工程资料目录"],
  ["联系单编号唯一","附件目录须先建末级目录"]),
 ("监理通知单","下发整改要求并闭环",18,
  ["针对现场问题下发整改要求","可关联监理日记并跟踪回复闭环","详情展示关联日记摘要"],
  ["仅可关联同项目、已审核通过的日记","走独立服务链路，字段扩展边界清晰"]),
 ("日常巡检","现场巡视备忘（免审核）",19,
  ["以检查表方式记录现场巡视","保存即为“已保存”，本人可继续补充","支持附件上传"],
  ["免审核：状态为 recorded","与日记/日志的审核状态机不同"]),
 ("旁站检查","关键部位旁站过程记录（免审核）",20,
  ["记录关键部位旁站过程","支持附件与检查清单","保存后可再编辑"],
  ["免审核：状态为 recorded","归属项目并纳入统计"]),
 ("日记报表","监理日记汇总",21,
  ["按项目与人员汇总监理日记","便于查阅与导出"],
  ["依赖已填报数据，空项目无结果"]),
 ("日志统计","监理日志填报分析",22,
  ["呈现日志填报覆盖率与趋势","辅助管理考核"],
  ["统计口径以填报规范为准"]),
 ("安全日志统计","安全隐患与整改分析",23,
  ["汇总安全隐患与整改情况","按项目维度统计"],
  ["依赖安全日志填报数据"]),
 ("日记统计","监理日记填报分析",24,
  ["按时间维度分析日记填报情况","辅助掌握现场记录活跃度"],
  ["依赖日记填报数据"]),
 ("消息中心","通知与待办提醒",25,
  ["集中接收系统通知与待办提醒","保障信息及时触达"],
  ["与审核、回复等业务动作联动"]),
 ("操作日志","关键操作留痕审计",26,
  ["记录关键业务操作留痕","满足审计与责任追溯要求"],
  ["覆盖全站关键写操作"]),
 ("流程管理","业务闭环可视化",27,
  ["呈现填报—提交—审核业务闭环","规范现场管理动作"],
  ["与各记录的状态机一致"]),
 ("工作标准配置","统一填报口径",28,
  ["统一维护填报规范与栏目口径","保证全站数据一致"],
  ["与前端 placeholder、导出列口径同源"]),
]
for (t,sub,idx,pts,nts) in FEATURES:
    feature_slide(t,sub,frame(idx),pts,nts)

# ============ 附件与目录关联机制 ============
s=new_slide(); title_bar(s,"附件与工程资料目录关联机制","一套目录树，多处复用；绑定信息随附件持久化")
card(s,0.62,1.75,6.0,4.7,"机制说明",["唯一数据源：GET /sub-item-databases/tree?projectId=","目录为“项目 → 单位 → 分部 → 分项”层级，仅末级可绑定","选择结果以 dirs 数组写入每个附件对象（目录完整路径）","dirs 随 attachments JSON 存 TEXT 列，后端逐字存取","附件鉴权只读 url、忽略 dirs，故绑定不丢、无需改表","前端渲染时过滤 status=inactive 的软删除目录"],size=13)
card(s,6.85,1.75,5.85,4.7,"使用限制（重要）",["须先在“工程资料目录设置”建好末级目录","附件必须经 /files/upload 真实上传，伪造 URL 会被拒","附件一经绑定项目，不可跨项目复用","切换项目后目录候选按新项目重新加载，不跨项目污染","未建目录时显示“暂无工程资料目录”为正确行为"],head_color=ORANGE,size=13)

# ============ 审核留痕与版本机制 ============
s=new_slide(); title_bar(s,"审核留痕与版本机制","提交—审核—驳回全程留痕，历史版本可完整回看")
card(s,0.62,1.75,6.0,4.7,"状态机",["常规状态：draft 草稿 → submitted 已提交 →","approved 已通过 / rejected 已驳回","日常巡检/旁站为免审核：保存即 recorded","状态判定统一由后端 FieldRecordKind 驱动","并发安全：lock_version 乐观锁防止覆盖"],size=13)
card(s,6.85,1.75,5.85,4.7,"驳回与修订留痕",["记录被驳回后，该版本即被冻结，不可再编辑/覆盖/删除","需再次提交时，基于驳回版本新建独立修订版本 V2","V2 再驳回可继续建 V3，以此类推","历史版本的正文、照片、附件、审核信息均可回看","V2/V3 通过 source_record_id 溯源至原始记录"],size=13)

# ============ 关键关联关系 ============
s=new_slide(); title_bar(s,"关键关联关系总览","数据之间如何互相引用")
rows=[("项目","1 — N","目录树 / 现场记录 / 人员 / 资料","一切业务数据按项目归属与隔离"),("工程资料目录","1 — N","记录附件（dirs）","附件绑定末级目录，目录为唯一数据源"),("监理日记","1 — N","监理日志（预填）","日志从同项目当日已审核日记取数预填"),("监理通知单","N — 1","监理日记（relatedDiaryId）","仅可关联同项目、已审核通过的日记"),("记录版本","N — 1","原始记录（source_record_id）","驳回后 V2/V3 溯源，历史可回看")]
rect(s,0.62,1.85,12.08,0.6,NAVY)
heads=["主体","关系","关联对象","说明"]; widths=[2.3,1.2,4.0,4.58]; hx=0.62
for htxt,wdt in zip(heads,widths):
    tf=tb(s,hx+0.15,1.95,wdt-0.2,0.4); para(tf,htxt,13.5,True,WHITE,first=True); hx+=wdt
y=2.45
for i,(a,b,c,d) in enumerate(rows):
    rect(s,0.62,y,12.08,0.78,CARD if i%2==0 else WHITE)
    vals=[a,b,c,d]; vx=0.62
    for j,(v,wdt) in enumerate(zip(vals,widths)):
        tf=tb(s,vx+0.15,y+0.16,wdt-0.2,0.55)
        para(tf,v,12.5,(j==0),NAVY if j==0 else (ACCENT if j==1 else INK),first=True); vx+=wdt
    y+=0.78

# ============ 进展与下一步 ============
s=new_slide(); title_bar(s,"当前进展与下一步","已初步开发完成；仍需大量测试与真实业务探索操作")
card(s,0.62,1.75,6.0,4.4,"已完成",["核心功能开发：项目/组织/目录/记录/审核/统计","附件与工程资料目录关联（多表单已打通）","审核留痕与版本机制（驳回冻结、V2/V3 溯源）","自动化回归：后端数百项、前端百余项测试","真实浏览器逐页验收（含目录关联链路）"],head_color=GREEN,size=13)
card(s,6.85,1.75,5.85,4.4,"待完成 / 限制",["仍需大量测试与真实业务探索操作","生产 MySQL 数据库迁移脚本待执行","正式环境部署与后端重启待进行","微信小程序真机验收尚未开展","窄屏/边界/并发等场景需进一步验证"],head_color=ORANGE,size=13)
rect(s,0.62,6.35,12.08,0.7,RGBColor(0xFD,0xF3,0xE7),shape=MSO_SHAPE.ROUNDED_RECTANGLE)
tf=tb(s,0.92,6.5,11.5,0.45); para(tf,"结论：系统已具备演示与试运行条件，但正式对外使用前须完成充分的真实业务验证。",13.5,True,ORANGE,first=True)

# ============ 结束页 ============
s=new_slide(); rect(s,0,0,13.333,7.5,NAVY); rect(s,0,7.28,13.333,0.22,ACCENT)
tf=tb(s,0.9,2.9,11.5,1.6)
para(tf,"谢谢聆听",46,True,WHITE,first=True,space_after=16)
para(tf,"监理现场管理系统 · 开发阶段汇报",18,False,RGBColor(0xC9,0xD8,0xF2))
tf2=tb(s,0.9,5.4,11.5,0.9); para(tf2,"下一步：结合真实项目开展充分测试与业务探索，推进生产部署与小程序真机验收。",14,False,RGBColor(0xA9,0xBE,0xE6),first=True)

prs.save(OUT)
print("已生成:", OUT)
print("总页数:", len(prs.slides._sldIdLst), "（含功能展示页 %d 页）" % len(FEATURES))
