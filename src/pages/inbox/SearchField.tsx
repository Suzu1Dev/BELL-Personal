/**
 * The mail search field (SPEC-mail-assignments §4.1, §4.2 item 6):
 * `[role=search]` › `label.inbox-search` with the Search icon, the input and
 * either the 「/」 hint or the clear button. Nothing is searched while an IME
 * composes: `onInput` says whether the text is final. ↵ searches Gmail at
 * once, ↓ moves to the first result, Esc clears the text and then leaves the
 * field; none of them act while composing.
 */
import { useState, type KeyboardEvent, type RefObject } from "react";
import { MAIL_SEARCH_LIMITS } from "../../../shared/mail";
import { MAIL_SEARCH } from "../../copy/inbox";
import { Button } from "../../components/Button";
import { Icon, Search, X } from "../../components/Icon";
import { isComposing } from "../../lib/keys";
import { useSingleKeyShortcuts } from "../../lib/preferences";

export interface SearchFieldProps {
  value: string;
  inputRef: RefObject<HTMLInputElement | null>;
  /** Every change; `final` is false while an IME is composing. */
  onInput: (value: string, final: boolean) => void;
  /** ↵: search Gmail now. */
  onSubmit: () => void;
  /** ↓: focus the first result. */
  onFirstResult: () => void;
  /** Esc on an empty field: back to the list. */
  onLeave: () => void;
}

export function SearchField({ value, inputRef, onInput, onSubmit, onFirstResult, onLeave }: SearchFieldProps) {
  const singleKeys = useSingleKeyShortcuts();
  const [composing, setComposing] = useState(false);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (composing || isComposing(event.nativeEvent)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      onSubmit();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      onFirstResult();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (value) onInput("", true);
      else onLeave();
    }
  };
  return (
    <div className="inbox-search-box" role="search" aria-label={MAIL_SEARCH.label}>
      <label className="inbox-search">
        <Icon icon={Search} />
        <input
          ref={inputRef}
          type="search"
          value={value}
          placeholder={MAIL_SEARCH.placeholder}
          aria-label={MAIL_SEARCH.label}
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
          maxLength={MAIL_SEARCH_LIMITS.query}
          onChange={(event) => onInput(event.target.value, !composing && !(event.nativeEvent as InputEvent).isComposing)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={(event) => {
            setComposing(false);
            onInput(event.currentTarget.value, true);
          }}
          onKeyDown={onKeyDown}
        />
        {value ? (
          <Button variant="icon" size="sm" icon={X} className="inbox-search-clear" aria-label={MAIL_SEARCH.clear} onClick={() => { onInput("", true); inputRef.current?.focus(); }} />
        ) : singleKeys ? <kbd aria-hidden="true">/</kbd> : null}
      </label>
    </div>
  );
}
