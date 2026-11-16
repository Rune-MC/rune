/** @jsxImportSource react */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { playerUuid } from "./avatar-url.ts";
import { PlayerHead } from "./identity.tsx";
import type { PlayerOption, PlayerOptions } from "./players.ts";

type Props = { id: string; name: string; label: string; availability: "known" | "online"; required: boolean; value: string; describedBy?: string };
type Result = { query: string; data: PlayerOptions | null };
const requests = new Map<string, Promise<PlayerOptions>>();
function options(availability: Props["availability"], query = "", selected = "") {
  const url = "/api/player-options?" + new URLSearchParams({ availability, q: query, selected });
  const pending = requests.get(url);
  if (pending) return pending;
  const request = fetch(url, { headers: { Accept: "application/json" }, redirect: "error" }).then(async (response) => {
    if (!response.ok) throw new Error("Player list unavailable.");
    return await response.json() as PlayerOptions;
  }).finally(() => requests.delete(url));
  requests.set(url, request);
  return request;
}

function OptionIdentity({ player }: { player: PlayerOption }) {
  return <span className="picker-identity">
    <PlayerHead name={player.name} id={player.id} />
    <span className="picker-player-text"><strong>{player.name}</strong><small>{player.id}</small></span>
  </span>;
}

export function PlayerPicker({ id, name, label, availability, value, describedBy, required }: Props) {
  const [selected, select] = useState<PlayerOption | null>(() => value ? {
    id: value, name: playerUuid.test(value) ? "Unseen player" : value,
  } : null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [result, setResult] = useState<Result | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = id + "-options";
  const resultForQuery = result?.query === query ? result : null;
  const rows = resultForQuery?.data?.options ?? [];

  useEffect(() => {
    if (!value) return;
    let current = true;
    void options(availability, "", value).then(({ selected }) => {
      if (current && selected) select((prev) => prev?.id === value ? selected : prev);
    }).catch(() => {});
    return () => { current = false; };
  }, [availability, value]);

  useEffect(() => {
    if (!open) return;
    let current = true;
    const timer = window.setTimeout(() => {
      void options(availability, query).then((data) => {
        if (current) setResult({ query, data });
      }).catch(() => {
        if (current) setResult({ query, data: null });
      });
    }, query ? 130 : 0);
    return () => { current = false; window.clearTimeout(timer); };
  }, [availability, open, query]);

  useEffect(() => {
    if (open && active >= 0) document.getElementById(listId + "-" + active)?.scrollIntoView({ block: "nearest" });
  }, [active, listId, open, resultForQuery]);

  function close() {
    setOpen(false);
    setQuery("");
    setActive(-1);
  }

  function choose(player: PlayerOption) {
    input.current?.setCustomValidity("");
    select(player);
    close();
  }

  function keyboard(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      if (rows.length) setActive((index) => event.key === "ArrowDown"
        ? Math.min(index + 1, rows.length - 1)
        : index < 0 ? rows.length - 1 : Math.max(index - 1, 0));
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      close();
    } else if (event.key === "Enter" && open) {
      event.preventDefault();
      if (rows[active]) choose(rows[active]);
    }
  }

  const shown = !open && selected;
  return <div className="player-picker">
    <input type="hidden" name={name} value={selected?.id ?? ""} />
    <div className={"picker-control" + (shown ? " picker-has-selection" : "")}>
      {shown && <span className="picker-current" aria-hidden="true"><OptionIdentity player={shown} /></span>}
      <input ref={input} id={id} role="combobox" aria-autocomplete="list" aria-expanded={open}
        aria-controls={open ? listId : undefined} aria-activedescendant={open && rows[active] ? listId + "-" + active : undefined}
        aria-describedby={describedBy} aria-required={required || undefined} required={required}
        value={open ? query : selected?.name ?? ""} placeholder="Search by name or UUID" autoComplete="off"
        autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={64}
        onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onBlur={close} onKeyDown={keyboard}
        onInvalid={(event) => {
          event.currentTarget.setCustomValidity("Choose a player from the list.");
        }}
        onChange={(event) => {
          event.currentTarget.setCustomValidity(!selected && required && event.target.value ? "Choose a player from the list." : "");
          setQuery(event.target.value);
          setActive(-1);
        }} />
      {!required && selected && <button type="button" className="picker-button" aria-label={"Clear " + label}
        onMouseDown={(event) => event.preventDefault()} onClick={() => { select(null); close(); input.current?.focus(); }}>
        <X size={15} aria-hidden="true" />
      </button>}
      <button type="button" tabIndex={-1} className="picker-button" aria-label={open ? "Close player list" : "Open player list"}
        onMouseDown={(event) => event.preventDefault()} onClick={() => {
          if (open) close();
          else { input.current?.focus(); setOpen(true); }
        }}><ChevronDown size={16} aria-hidden="true" /></button>
    </div>
    {open && <div className="picker-popup">
      <ul role="listbox" aria-label={label} id={listId}>
        {rows.map((player, index) => <li key={player.id} id={listId + "-" + index} role="option"
          aria-selected={player.id === selected?.id} data-active={active === index || undefined}
          onMouseDown={(event) => event.preventDefault()} onClick={() => choose(player)}>
          <OptionIdentity player={player} />
          {player.id === selected?.id && <Check size={17} className="picker-check" aria-hidden="true" />}
        </li>)}
      </ul>
      <div role="status" className="picker-status">
        {!resultForQuery ? "Loading players…" : !resultForQuery.data ? "Player list unavailable. Reopen to try again." :
          !rows.length ? "No matching players." : resultForQuery.data.more ? "Search to narrow the results." : ""}
      </div>
    </div>}
  </div>;
}
