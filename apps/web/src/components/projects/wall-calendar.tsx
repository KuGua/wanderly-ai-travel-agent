"use client";

import { useLocale } from "next-intl";
import { useSyncExternalStore } from "react";
import styles from "./projects-manager.module.css";

function localDay() {
  const now = new Date();
  return `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}`;
}

function subscribeDay(update: () => void) {
  const timer = setInterval(update, 60_000);
  document.addEventListener("visibilitychange", update);
  return () => {
    clearInterval(timer);
    document.removeEventListener("visibilitychange", update);
  };
}

export function WallCalendar() {
  const locale = useLocale();
  // Client-local date, with an empty server snapshot to avoid timezone hydration differences.
  const day = useSyncExternalStore(subscribeDay, localDay, () => "");
  if (!day) return null;
  const [year, month, today] = day.split("/").map(Number);
  const first = new Date(year, month - 1, 1);
  const count = new Date(year, month, 0).getDate();
  const offset = (first.getDay() + 6) % 7;
  const rows = Math.ceil((offset + count) / 7);
  const title = new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(first);
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "narrow" });

  return <div className={styles.wallCalendar}>
    <table aria-label={title}>
      <caption>{title}</caption>
      <thead><tr>{Array.from({ length: 7 }, (_, index) => <th key={index} scope="col">
        {weekday.format(new Date(2024, 0, 1 + index))}
      </th>)}</tr></thead>
      <tbody>{Array.from({ length: rows }, (_, row) => <tr key={row}>
        {Array.from({ length: 7 }, (_, column) => {
          const date = row * 7 + column - offset + 1;
          return <td key={column} aria-current={date === today ? "date" : undefined}>
            {date > 0 && date <= count ? date : null}
          </td>;
        })}
      </tr>)}</tbody>
    </table>
  </div>;
}
