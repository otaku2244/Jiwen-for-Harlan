"""用 Serein 的真实剥离函数处理积温桥产出的块。

被 _test/conformance_check.js 调用，不单独使用：
    python conformance_strip.py <corpus.json> <serein_src_dir> <out.json>

之所以要真函数而不是本地复刻：契约的破裂形态（跳过态吞掉她的话）完全取决于
chat_context.py 的实现细节，复刻一遍只能验证"我以为的规则"，验证不了"实际规则"。
"""
import json
import sys

corpus_path, serein_src, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
sys.path.insert(0, serein_src)

try:
    from serein.chat_context import ClientContext
except Exception as exc:  # noqa: BLE001
    with open(out_path, 'w', encoding='utf-8') as fh:
        json.dump({'error': 'import failed: %r' % (exc,)}, fh, ensure_ascii=False)
    sys.exit(0)

ctx = ClientContext()
with open(corpus_path, encoding='utf-8') as fh:
    cases = json.load(fh)

out = []
for case in cases:
    try:
        out.append({
            'label': case['label'],
            'result': ctx._strip_external_context_from_user_text(case['text']),
        })
    except Exception as exc:  # noqa: BLE001
        out.append({'label': case['label'], 'error': repr(exc)})

with open(out_path, 'w', encoding='utf-8') as fh:
    json.dump(out, fh, ensure_ascii=False)
print('STRIP_OK %d' % len(out))
