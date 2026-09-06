"use client";

import { useRef } from "react";
import { Plus } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { useTravelApi } from "@/lib/query/provider";
import { tripKeys } from "@/lib/query/keys";
import styles from "./projects-manager.module.css";

export function NewTripButton() {
  const t = useTranslations("recordRoom");
  const api = useTravelApi();
  const cache = useQueryClient();
  const router = useRouter();
  const requestId = useRef<string | null>(null);
  const busy = useRef(false);
  const create = useMutation({
    mutationFn: () => {
      requestId.current ??= crypto.randomUUID();
      return api.startExploration({ requestId: requestId.current });
    },
    onSuccess: (response) => {
      void cache.invalidateQueries({ queryKey: tripKeys.all });
      router.push(`/trips/${response.trip.id}?thread=${response.defaultThread.id}` as Parameters<typeof router.push>[0]);
    },
    onError: () => { busy.current = false; },
  });
  return <div className={styles.newTripAction}>
    <button type="button" className={styles.newTripButton} disabled={create.isPending || create.isSuccess}
      onClick={() => { if (!busy.current) { busy.current = true; create.mutate(); } }}>
      <Plus size={18} aria-hidden="true" />{t(create.isPending ? "creating" : "newTrip")}
    </button>
    {create.isError && <p role="alert" className={styles.createError}>{t("createError")}</p>}
  </div>;
}
