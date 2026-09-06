"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { TripSummary } from "@/lib/api/contracts";
import { useDeleteTrip } from "@/lib/query/hooks";
import styles from "./projects-manager.module.css";

type Props = {
  trips: TripSummary[];
  draggedId: string | null;
  selection: string | null;
  onSelect: (id: string | null) => void;
  onDragClear: () => void;
};

/** The drop only selects a record. Only an explicit dialog confirmation deletes it. */
export function RecordTrash({ trips, draggedId, selection, onSelect, onDragClear }: Props) {
  const t = useTranslations("recordRoom");
  const [over, setOver] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const silhouetteId = useId();
  const owned = trips.filter((trip) => trip.role === "CREATOR");
  const dragged = owned.find((trip) => trip.id === draggedId);
  const selected = owned.find((trip) => trip.id === selection);
  const close = () => { onSelect(null); button.current?.focus(); };

  return <>
    <button ref={button} type="button" className={styles.trash}
      data-dragging={Boolean(dragged)} data-over={Boolean(dragged && over)}
      aria-label={t("trash")} title={t("trashHint")}
      onClick={() => onSelect("")}
      onDragOver={(event) => {
        if (!dragged) return;
        event.preventDefault(); event.dataTransfer.dropEffect = "move"; setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault(); setOver(false);
        if (dragged) onSelect(dragged.id);
        onDragClear();
      }}>
      <svg viewBox="220 60 830 1040" aria-hidden="true" focusable="false">
        <defs>
          <clipPath id={silhouetteId}>
            <path d="M631 78 C835 78 1007 135 1023 230 C1031 265 1011 319 986 344 L927 903 C922 1000 800 1072 644 1072 C475 1072 337 1033 327 941 L258 334 C230 299 230 254 242 218 C275 125 450 78 631 78Z" />
          </clipPath>
        </defs>
        <image href="/images/record-room-wastebasket.png" width="1254" height="1254" clipPath={`url(#${silhouetteId})`} />
      </svg>
      <span className={styles.trashHint}>{dragged ? t("dropToDelete") : t("trashHint")}</span>
    </button>
    {selection !== null && <DeleteRecordDialog trips={owned} trip={selected} onSelect={onSelect} onClose={close} />}
  </>;
}

function DeleteRecordDialog({ trips, trip, onSelect, onClose }: {
  trips: TripSummary[]; trip?: TripSummary; onSelect: (id: string) => void; onClose: () => void;
}) {
  const t = useTranslations("recordRoom");
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const locked = useRef(false);
  const titleId = useId();
  const bodyId = useId();
  const mutation = useDeleteTrip(trip?.id ?? "");
  useEffect(() => { dialog.current?.showModal(); cancel.current?.focus(); }, []);
  const close = () => { dialog.current?.close(); onClose(); };
  const confirm = async () => {
    if (!trip || locked.current) return;
    locked.current = true;
    try { await mutation.mutateAsync(); close(); }
    catch { /* Keep the record and show the localized error; server remains authoritative. */ }
    finally { locked.current = false; }
  };
  return <dialog ref={dialog} className={styles.deleteDialog} aria-labelledby={titleId} aria-describedby={bodyId}
    onCancel={(event) => { event.preventDefault(); if (!locked.current) close(); }}>
    <h2 id={titleId}>{t(trip ? "deleteTitle" : "chooseRecord")}</h2>
    <p id={bodyId}>{trip ? t("deleteWarning", { name: trip.name }) : t(trips.length ? "chooseHint" : "noOwnedRecords")}</p>
    {!trip && trips.length > 0 && <div className={styles.deleteChoices}>{trips.map((item) =>
      <button key={item.id} type="button" onClick={() => onSelect(item.id)}>{item.name}</button>)}</div>}
    {mutation.isError && <p role="alert">{t("deleteError")}</p>}
    <div className={styles.deleteActions}>
      <button ref={cancel} type="button" disabled={mutation.isPending} onClick={() => { if (!locked.current) close(); }}>{t("cancelDelete")}</button>
      {trip && <button type="button" disabled={mutation.isPending} onClick={() => void confirm()}>{t(mutation.isPending ? "deleting" : "confirmDelete")}</button>}
    </div>
  </dialog>;
}
