/**
 * The AI marker (SPEC-ux §1 rule 2): `.ai-tag` 「AI 摘要」/「AI 建議」 with
 * sparkles, or `.ai-tag.rule` 「規則整理」/「規則解析」 for the rule fallback.
 * Every piece of model text carries one.
 */
import { GUIDE_SHARED } from "../copy/guide";
import { cx } from "../lib/cx";
import { Icon, Sparkles } from "./Icon";
import "./AiTag.css";

export type AiTagKind = keyof typeof GUIDE_SHARED.aiTags;

export function AiTag({ kind, title, className }: { kind: AiTagKind; title?: string; className?: string }) {
  const rule = kind === "rule" || kind === "ruleParse";
  return (
    <span className={cx("ai-tag", rule && "rule", className)} title={title}>
      {rule ? null : <Icon icon={Sparkles} size="xs" />}
      {GUIDE_SHARED.aiTags[kind]}
    </span>
  );
}
