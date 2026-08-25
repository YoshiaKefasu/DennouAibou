import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { t } from "../../i18n/index.ts";
import type { SkillMessageMap } from "../controllers/skills.ts";
import { clampText } from "../format.ts";
import { resolveSafeExternalUrl } from "../open-external-url.ts";
import type { SkillStatusEntry, SkillStatusReport } from "../types.ts";
import { groupSkills } from "./skills-grouping.ts";
import {
  computeSkillMissing,
  computeSkillReasons,
  renderSkillStatusChips,
} from "./skills-shared.ts";

function safeExternalHref(raw?: string): string | null {
  if (!raw) {
    return null;
  }
  return resolveSafeExternalUrl(raw, window.location.href);
}

export type SkillsStatusFilter = "all" | "ready" | "needs-setup" | "disabled";

export type SkillsProps = {
  connected: boolean;
  loading: boolean;
  report: SkillStatusReport | null;
  error: string | null;
  filter: string;
  statusFilter: SkillsStatusFilter;
  edits: Record<string, string>;
  busyKey: string | null;
  messages: SkillMessageMap;
  detailKey: string | null;
  onFilterChange: (next: string) => void;
  onStatusFilterChange: (next: SkillsStatusFilter) => void;
  onRefresh: () => void;
  onToggle: (skillKey: string, enabled: boolean) => void;
  onEdit: (skillKey: string, value: string) => void;
  onSaveKey: (skillKey: string) => void;
  onInstall: (skillKey: string, name: string, installId: string) => void;
  onDetailOpen: (skillKey: string) => void;
  onDetailClose: () => void;
};

type StatusTabDef = { id: SkillsStatusFilter; label: string };

const STATUS_TABS: StatusTabDef[] = [
  { id: "all", label: "All" },
  { id: "ready", label: "Ready" },
  { id: "needs-setup", label: "Needs Setup" },
  { id: "disabled", label: "Disabled" },
];

function skillMatchesStatus(skill: SkillStatusEntry, status: SkillsStatusFilter): boolean {
  switch (status) {
    case "all":
      return true;
    case "ready":
      return !skill.disabled && skill.eligible;
    case "needs-setup":
      return !skill.disabled && !skill.eligible;
    case "disabled":
      return skill.disabled;
  }
}

function skillStatusClass(skill: SkillStatusEntry): string {
  if (skill.disabled) {
    return "muted";
  }
  return skill.eligible ? "ok" : "warn";
}

export function renderSkills(props: SkillsProps) {
  const skills = props.report?.skills ?? [];

  const statusCounts: Record<SkillsStatusFilter, number> = {
    all: skills.length,
    ready: 0,
    "needs-setup": 0,
    disabled: 0,
  };
  for (const s of skills) {
    if (s.disabled) {
      statusCounts.disabled++;
    } else if (s.eligible) {
      statusCounts.ready++;
    } else {
      statusCounts["needs-setup"]++;
    }
  }

  const searchFilter = props.filter.trim().toLowerCase();
  const filtered = skills.filter((s) => {
    if (!skillMatchesStatus(s, props.statusFilter)) {
      return false;
    }
    if (!searchFilter) {
      return true;
    }
    return (
      s.name.toLowerCase().includes(searchFilter) ||
      s.description.toLowerCase().includes(searchFilter) ||
      s.skillKey.toLowerCase().includes(searchFilter)
    );
  });

  const groups = groupSkills(filtered);
  const detailSkill = props.detailKey
    ? (skills.find((s) => s.skillKey === props.detailKey) ?? null)
    : null;

  return html`
    <section class="card">
      <div class="section-header">
        <div>
          <div class="section-title">${t("skills.title")}</div>
          <div class="section-sub">${t("skills.subtitle")}</div>
        </div>
        <div style="display: flex; gap: 8px;">
          <button
            class="btn btn--sm"
            ?disabled=${props.loading || !props.connected}
            @click=${props.onRefresh}
          >
            ${props.loading ? t("common.loading") : t("common.refresh")}
          </button>
        </div>
      </div>

      <!-- Status Filter Tabs -->
      <div style="display: flex; gap: 6px; margin-top: 14px; flex-wrap: wrap;">
        ${STATUS_TABS.map(
          (tab) => html`
            <button
              class="btn btn--sm ${props.statusFilter === tab.id ? "primary" : ""}"
              @click=${() => props.onStatusFilterChange(tab.id)}
            >
              ${tab.label}
              <span class="muted" style="margin-left: 4px; font-size: 11px;">
                ${statusCounts[tab.id]}
              </span>
            </button>
          `,
        )}
      </div>

      <!-- Search Filter -->
      <div
        style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 12px;"
      >
        <label class="field" style="flex: 1; min-width: 180px;">
          <input
            .value=${props.filter}
            @input=${(e: Event) => props.onFilterChange((e.target as HTMLInputElement).value)}
            placeholder="Filter installed skills"
            autocomplete="off"
            name="skills-filter"
          />
        </label>
        <div class="muted">${filtered.length} shown</div>
      </div>

      ${props.error
        ? html`<div class="callout danger" style="margin-top: 12px;">${props.error}</div>`
        : nothing}
      ${filtered.length === 0
        ? html`
            <div class="muted" style="margin-top: 16px">
              ${!props.connected && !props.report
                ? "Not connected to gateway."
                : "No skills found."}
            </div>
          `
        : html`
            <div class="agent-skills-groups" style="margin-top: 16px;">
              ${groups.map((group) => {
                return html`
                  <details class="agent-skills-group" open>
                    <summary class="agent-skills-header">
                      <span>${group.label}</span>
                      <span class="muted">${group.skills.length}</span>
                    </summary>
                    <div class="list skills-grid">
                      ${group.skills.map((skill) => renderSkill(skill, props))}
                    </div>
                  </details>
                `;
              })}
            </div>
          `}
    </section>

    ${detailSkill ? renderSkillDetail(detailSkill, props) : nothing}
  `;
}

function renderSkill(skill: SkillStatusEntry, props: SkillsProps) {
  const busy = props.busyKey === skill.skillKey;
  const dotClass = skillStatusClass(skill);

  return html`
    <div class="list-item list-item-clickable" @click=${() => props.onDetailOpen(skill.skillKey)}>
      <div class="list-main">
        <div class="list-title" style="display: flex; align-items: center; gap: 8px;">
          <span class="statusDot ${dotClass}"></span>
          ${skill.emoji ? html`<span>${skill.emoji}</span>` : nothing}
          <span>${skill.name}</span>
        </div>
        <div class="list-sub">${clampText(skill.description, 140)}</div>
      </div>
      <div
        class="list-meta"
        style="display: flex; align-items: center; justify-content: flex-end; gap: 10px;"
      >
        <label class="skill-toggle-wrap" @click=${(e: Event) => e.stopPropagation()}>
          <input
            type="checkbox"
            class="skill-toggle"
            .checked=${!skill.disabled}
            ?disabled=${busy}
            @change=${(e: Event) =>
              props.onToggle(skill.skillKey, (e.target as HTMLInputElement).checked)}
          />
          <span>${skill.disabled ? "Disabled" : "Enabled"}</span>
        </label>
        <span class="btn btn--sm">${t("common.manage")}</span>
      </div>
    </div>
  `;
}

function renderSkillDetail(skill: SkillStatusEntry, props: SkillsProps) {
  const editValue = props.edits[skill.skillKey] ?? "";
  const busy = props.busyKey === skill.skillKey;
  const msg = props.messages[skill.skillKey];
  const missing = computeSkillMissing(skill);
  const reasons = computeSkillReasons(skill);
  const homepage = safeExternalHref(skill.homepage);

  const ensureModalOpen = (el?: Element) => {
    if (!(el instanceof HTMLDialogElement) || el.open) {
      return;
    }
    el.showModal();
  };

  return html`
    <dialog
      class="md-preview-dialog"
      ${ref(ensureModalOpen)}
      @click=${(e: Event) => {
        const dialog = e.currentTarget as HTMLDialogElement;
        if (e.target === dialog) {
          dialog.close();
        }
      }}
      @close=${props.onDetailClose}
    >
      <div class="md-preview-dialog__panel">
        <div class="md-preview-dialog__header">
          <div class="md-preview-dialog__title">
            ${skill.emoji ? `${skill.emoji} ` : ""}${skill.name}
          </div>
          <button
            class="btn btn--sm"
            @click=${(e: Event) => {
              (e.currentTarget as HTMLElement).closest("dialog")?.close();
            }}
          >
            ${t("common.close")}
          </button>
        </div>
        <div class="md-preview-dialog__body" style="display: grid; gap: 14px;">
          <div>
            <div style="display: flex; gap: 6px; flex-wrap: wrap;">
              ${renderSkillStatusChips({ skill })}
            </div>
            <div class="muted" style="margin-top: 6px; font-size: 13px;">${skill.description}</div>
          </div>

          <div class="list-sub" style="display: grid; gap: 4px;">
            <div><strong>Source:</strong> ${skill.source}</div>
            <div><strong>Path:</strong> <code>${skill.filePath}</code></div>
            ${skill.primaryEnv
              ? html`<div><strong>Primary env:</strong> <code>${skill.primaryEnv}</code></div>`
              : nothing}
            ${homepage
              ? html`
                  <div>
                    <strong>Homepage:</strong>
                    <a href=${homepage} target="_blank" rel="noreferrer noopener">
                      ${skill.homepage}
                    </a>
                  </div>
                `
              : nothing}
          </div>

          ${missing.length > 0
            ? html`
                <div class="callout warn">
                  <strong>Missing requirements:</strong>
                  <div style="margin-top: 4px;">${missing.join(", ")}</div>
                </div>
              `
            : nothing}
          ${reasons.length > 0
            ? html`
                <div class="callout muted">
                  <strong>Status details:</strong>
                  <div style="margin-top: 4px;">${reasons.join(", ")}</div>
                </div>
              `
            : nothing}
          ${skill.primaryEnv
            ? html`
                <div class="card" style="padding: 12px; margin: 0;">
                  <div class="list-title" style="font-size: 13px;">
                    API Key (${skill.primaryEnv})
                  </div>
                  <div style="display: flex; gap: 8px; margin-top: 8px;">
                    <input
                      type="password"
                      class="field"
                      style="flex: 1;"
                      placeholder="Enter API key"
                      .value=${editValue}
                      @input=${(e: Event) =>
                        props.onEdit(skill.skillKey, (e.target as HTMLInputElement).value)}
                    />
                    <button
                      class="btn btn--sm primary"
                      ?disabled=${busy || !editValue.trim()}
                      @click=${() => props.onSaveKey(skill.skillKey)}
                    >
                      ${busy ? t("common.saving") : t("common.save")}
                    </button>
                  </div>
                </div>
              `
            : nothing}
          ${skill.install && skill.install.length > 0
            ? html`
                <div>
                  <div class="list-title" style="font-size: 13px; margin-bottom: 6px;">
                    Install Options
                  </div>
                  <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                    ${skill.install.map(
                      (opt) => html`
                        <button
                          class="btn btn--sm"
                          ?disabled=${busy}
                          @click=${() => props.onInstall(skill.skillKey, skill.name, opt.id)}
                        >
                          ${opt.label || opt.id}
                        </button>
                      `,
                    )}
                  </div>
                </div>
              `
            : nothing}
          ${msg
            ? html`
                <div class="callout ${msg.kind === "error" ? "danger" : "success"}">
                  ${msg.message}
                </div>
              `
            : nothing}
        </div>
      </div>
    </dialog>
  `;
}
