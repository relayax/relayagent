"use client";

import { useState } from "react";
import { SECTIONS, sectionChangeCount, unclaimedFiles, type SectionDef } from "@/lib/sections";
import type { Manifest } from "@/lib/types";
import type { DraftChange } from "@/lib/studio";

// Figma 의 레이어 패널에 해당하는 선언 트리. 노드 = relay.yaml 선언.
// 미선언 섹션도 흐리게 전부 보여준다 — 트리 자체가 문법의 전체 어휘를 가르친다.
// 이름은 사람 말(lib/sections.ts label)로 부르고 문법 키는 작게 병기한다 — 팔레트와 같은 어휘다.
// 고급 선언(org · host_methods)은 접어 둔다: 개인 기판에서 거의 손대지 않는 것이 목록 한복판에
// 서면 나머지가 묻힌다. 선언돼 있거나 지금 보고 있으면 펼친다.

export default function DeclTree({
  manifest,
  files,
  changes,
  sec,
  item,
  onSelect,
}: {
  manifest: Manifest | null;
  files: string[];
  changes: DraftChange[];
  sec: string | null;
  item: string | null;
  onSelect: (sec: string | null, item?: string | null) => void;
}) {
  const m = manifest ?? {};
  const changed = new Set(changes.map((c) => c.file));
  const extra = manifest ? unclaimedFiles(m, files) : files;
  const main = SECTIONS.filter((s) => !s.advanced);
  const adv = SECTIONS.filter((s) => s.advanced);
  const [advOpen, setAdvOpen] = useState(false);
  const advShown = advOpen || adv.some((s) => s.key === sec || s.declared(m));

  const section = (s: SectionDef) => (
    <TreeSection
      key={s.key}
      def={s}
      m={m}
      files={files}
      changed={changed}
      active={sec === s.key}
      activeItem={sec === s.key ? item : null}
      onSelect={onSelect}
    />
  );

  return (
    <div className="st-tree">
      <div
        className={`st-node root${!sec ? " sel" : ""}`}
        onClick={() => onSelect(null)}
      >
        <b>{m.display_name ?? "패키지"}</b>
        {changed.size ? <span className="st-badge">{changed.size}</span> : null}
      </div>
      {main.map(section)}
      {adv.length ? (
        <div className="st-sec">
          <div className="st-node dim st-adv" onClick={() => setAdvOpen((v) => !v)} title="거의 손대지 않는 선언">
            <span>고급</span>
            <span className="st-count">{advShown ? "▾" : "▸"}</span>
          </div>
          {advShown ? adv.map(section) : null}
        </div>
      ) : null}
      {extra.length ? (
        <div className="st-sec">
          <div
            className={`st-node dim${sec === "files" ? " sel" : ""}`}
            onClick={() => onSelect("files")}
          >
            <span>기타 파일</span>
            <span className="st-count">{extra.length}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TreeSection({
  def,
  m,
  files,
  changed,
  active,
  activeItem,
  onSelect,
}: {
  def: SectionDef;
  m: Manifest;
  files: string[];
  changed: Set<string>;
  active: boolean;
  activeItem: string | null;
  onSelect: (sec: string | null, item?: string | null) => void;
}) {
  const declared = def.declared(m);
  const items = declared ? def.items?.(m, files) ?? null : null;
  const dirty = declared ? sectionChangeCount(def, m, files, changed) : 0;

  return (
    <div className="st-sec">
      <div
        className={`st-node${declared ? "" : " dim"}${active && !activeItem ? " sel" : ""}`}
        onClick={() => onSelect(def.key)}
        title={def.yamlKey ? `relay.yaml: ${def.yamlKey}` : undefined}
      >
        <span className="st-it">
          {def.label}
          {def.yamlKey ? <small className="st-key">{def.yamlKey}</small> : null}
        </span>
        {dirty ? <span className="st-badge">{dirty}</span> : null}
        {items?.length ? <span className="st-count">{items.length}</span> : null}
        {!declared ? <span className="st-add">+</span> : null}
      </div>
      {active && items
        ? items.map((it) => (
            <div
              key={it.id}
              className={`st-node sub${activeItem === it.id ? " sel" : ""}`}
              onClick={() => onSelect(def.key, it.id)}
            >
              <span className="st-it">{it.title}</span>
              {it.files.some((f) => changed.has(f)) ? <span className="st-dot" /> : null}
            </div>
          ))
        : null}
    </div>
  );
}
