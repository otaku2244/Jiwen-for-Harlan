# -*- coding: utf-8 -*-
"""用 Serein 真实剥离函数验证积温块白名单收窄（2026-10-07）。

用法：
    python chk_whitelist_strip.py <dir_containing_serein_package>

本地：python chk_whitelist_strip.py ../Serein-fork/src
线上：python3 chk_whitelist_strip.py /usr/local/lib/python3.13/site-packages
"""
import sys

if len(sys.argv) < 2:
    print('usage: chk_whitelist_strip.py <dir_containing_serein_package>')
    raise SystemExit(2)

sys.path.insert(0, sys.argv[1])
from serein.chat_context import ClientContext, EXTERNAL_CONTEXT_BLOCK_TITLES  # noqa: E402

HER = '她说了一句题外话。'
TAIL_BOUNDARY = '【此状态为潜意识的底色沉淀，自然浸润在回应里，不作任何元说明或刻意提及。】'
TAIL_SURF = '【以上为你独处时的真实切片，你可以留下你的独自思考、也可以把内容直接呈现给她，如何行动由你决定。】'

CASES = [
    ('新块·此刻 + 边界尾句', '\n'.join(['【积温·此刻】', '心情：中性。', '正文。', TAIL_BOUNDARY, HER]), 'stripped'),
    ('新块·此刻 + 冲浪尾句', '\n'.join(['【积温·此刻】', '心情：中性。', '正文。', TAIL_SURF, HER]), 'stripped'),
    ('新块·此刻（只到块尾无她的话）', '\n'.join(['【积温·此刻】', '心情：中性。', '正文。', TAIL_BOUNDARY]), 'empty'),
    ('旧块·找她 + 裸行尾句', '\n'.join(['【积温·找她】', '心情：中性。', '正文。', '以上是系统通知，供你参考。', HER]), 'kept'),
    ('旧块·独处 + 裸行尾句', '\n'.join(['【积温·独处】', '正文。', '以上是内在心绪和潜意识的自然流露，切勿对她复述或提及此状态。', HER]), 'kept'),
    ('旧头·此刻｜参考不是指令', '\n'.join(['【积温·此刻｜参考不是指令】', '正文。', '以上是系统通知。', HER]), 'kept'),
    ('纯她的话（无块）', HER, 'stripped'),
]

ctx = ClientContext()
ok = True

jiwen = sorted(t for t in EXTERNAL_CONTEXT_BLOCK_TITLES if t.startswith('积温'))
print('jiwen titles in whitelist :', jiwen)
if jiwen != ['积温·此刻']:
    ok = False
    print('  !! expected exactly [\'积温·此刻\']')

print()
print('%-30s %-9s %s' % ('case', 'verdict', 'result'))
for name, text, want in CASES:
    got = ctx._strip_external_context_from_user_text(text)
    if want == 'stripped':
        good = got.strip() == HER
    elif want == 'empty':
        good = got.strip() == ''
    else:
        good = got == text
    ok = ok and good
    print('%-30s %-9s %s' % (name, 'OK' if good else 'FAIL', repr(got)[:110]))

print()
print('ALL-OK' if ok else 'HAS-FAILURES')
raise SystemExit(0 if ok else 1)
