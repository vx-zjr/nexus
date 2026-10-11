"""
身份匹配打分（nomenklatura logic-v2，OpenSanctions 同款匹配算法）。

stdin  每行一个 JSON：{"id": "...", "a": {"schema": "Person", "names": [...], "countries": [...], "born": "1961"}, "b": {...}}
stdout 每行一个 JSON：{"id": "...", "score": 0.93, "features": {...}}

用法：tools/py/.venv/bin/python tools/py/score_pairs.py < pairs.jsonl > scores.jsonl
环境：python -m venv tools/py/.venv && tools/py/.venv/bin/pip install nomenklatura followthemoney
"""
import json
import sys

from followthemoney import model
from nomenklatura.matching import get_algorithm
from nomenklatura.matching.types import ScoringConfig

ALGO = get_algorithm("logic-v2")
CFG = ScoringConfig(weights={}, config={})


def make(side: dict, eid: str):
    schema = side.get("schema") or "LegalEntity"
    e = model.make_entity(schema if schema in model.schemata else "LegalEntity")
    e.id = eid
    for n in side.get("names") or []:
        e.add("name", n, quiet=True)
    for c in side.get("countries") or []:
        e.add("country", c.lower(), quiet=True)
    if side.get("born") and e.schema.is_a("Person"):
        e.add("birthDate", side["born"], quiet=True)
    return e


def main() -> None:
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        row = json.loads(line)
        try:
            a = make(row["a"], "a")
            b = make(row["b"], "b")
            res = ALGO.compare(a, b, CFG)
            feats = {}
            for k, v in (getattr(res, "features", None) or {}).items():
                s = getattr(v, "score", v)
                if isinstance(s, (int, float)) and s:
                    feats[k] = round(float(s), 3)
            out.write(json.dumps({"id": row["id"], "score": round(float(res.score), 4), "features": feats}) + "\n")
        except Exception as exc:  # 单条失败不影响整体
            out.write(json.dumps({"id": row["id"], "score": None, "error": str(exc)}) + "\n")
    out.flush()


if __name__ == "__main__":
    main()
