import { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { AlertTriangle, ChevronRight } from "lucide-react-native";
import type { SubjectStat } from "@attendly/protocol";
import { Screen } from "@kit/components/Screen";
import {
  Badge,
  Card,
  ErrorState,
  IconTile,
  Loading,
  ProgressBar,
  Segmented,
  Text,
} from "@kit/components/ui";
import { pct } from "@kit/lib/format";
import { useSubjects } from "@/state/queries";
import { colors, fonts } from "@kit/theme";

type Filter = "all" | "theory" | "lab" | "risk";
const FILTERS = [
  { value: "all", label: "All" },
  { value: "theory", label: "Theory" },
  { value: "lab", label: "Lab" },
  { value: "risk", label: "At risk" },
] as const;

/** 08 · Subjects — the 75% rule, per course. */
export default function Subjects() {
  const q = useSubjects();
  const [filter, setFilter] = useState<Filter>("all");
  const list = useMemo(() => {
    const all = q.data?.subjects ?? [];
    if (filter === "all") return all;
    if (filter === "risk") return all.filter((s) => s.standing === "at-risk");
    return all.filter((s) => s.kind === filter);
  }, [q.data, filter]);

  if (q.isPending)
    return (
      <Screen scroll={false}>
        <Loading />
      </Screen>
    );
  if (q.isError && !q.data)
    return (
      <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
        <View style={{ marginTop: 40 }}>
          <ErrorState
            message={q.error.message}
            onRetry={() => void q.refetch()}
          />
        </View>
      </Screen>
    );

  const d = q.data!;
  const risky = d.subjects.filter((s) => s.standing === "at-risk");
  const worst = [...risky].sort((a, b) => b.needToReach - a.needToReach)[0];

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <Text variant="label" style={{ marginTop: 4 }}>
        {`${d.termName} · Week ${d.termWeek}`}
      </Text>
      <Text variant="title" style={{ marginTop: 4 }}>
        My subjects
      </Text>

      {worst ? (
        <Card tone="amber" style={styles.alert}>
          <IconTile tone="amber">
            <AlertTriangle color={colors.amber} size={18} />
          </IconTile>
          <View style={{ flex: 1 }}>
            <Text variant="bodyStrong">
              {risky.length} {risky.length === 1 ? "subject" : "subjects"} below{" "}
              {pct(d.minPercent)}%
            </Text>
            <Text variant="small">
              {worst.needToReach >= 10_000
                ? `${worst.code} can no longer reach ${pct(d.minPercent)}% this term. Talk to your instructor.`
                : `Attend the next ${worst.needToReach} ${worst.code} ${worst.needToReach === 1 ? "session" : "sessions"} in a row to get back to ${pct(d.minPercent)}%.`}
            </Text>
          </View>
        </Card>
      ) : d.subjects.length > 0 ? (
        <Card tone="green" style={styles.alert}>
          <Text variant="small" color={colors.green}>
            All subjects are at or above {pct(d.minPercent)}%. Keep it up.
          </Text>
        </Card>
      ) : null}

      <View style={{ marginTop: 16, marginBottom: 12 }}>
        <Segmented value={filter} options={FILTERS} onChange={setFilter} />
      </View>

      <View style={{ gap: 10 }}>
        {list.length === 0 ? (
          <Card>
            <Text variant="small">
              {filter === "risk"
                ? "Nothing at risk. 🎯"
                : "No subjects in this view."}
            </Text>
          </Card>
        ) : (
          list.map((s) => (
            <SubjectCard key={s.courseId} s={s} min={d.minPercent} />
          ))
        )}
      </View>
    </Screen>
  );
}

function SubjectCard({ s, min }: { s: SubjectStat; min: number }) {
  const risk = s.standing === "at-risk";
  return (
    <Pressable
      onPress={() =>
        router.push({ pathname: "/subject/[id]", params: { id: s.courseId } })
      }
      accessibilityRole="button"
      accessibilityLabel={`${s.title}, ${pct(s.percent)} percent. Open details`}
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
    >
      <Card tone={risk ? "amber" : undefined}>
        <View style={styles.top}>
          <View style={{ flex: 1, gap: 2 }}>
            <View
              style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
            >
              <Text variant="monoSmall">{s.code}</Text>
              {risk ? <Badge label="AT RISK" tone="amber" /> : null}
              {s.kind === "lab" ? (
                <Badge label="Lab" tone="violet" dot={false} />
              ) : null}
            </View>
            <Text variant="bodyStrong" numberOfLines={1}>
              {s.title}
            </Text>
            {s.instructor ? <Text variant="small">{s.instructor}</Text> : null}
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <View style={{ flexDirection: "row", alignItems: "flex-end" }}>
              <Text
                style={[
                  styles.big,
                  { color: risk ? colors.amber : colors.text },
                ]}
              >
                {pct(s.percent)}
              </Text>
              {s.percent !== null ? (
                <Text style={styles.pctSign}>%</Text>
              ) : null}
            </View>
            <Text variant="monoSmall">
              {s.attended}/{s.held}
            </Text>
          </View>
        </View>
        <View style={{ marginTop: 12 }}>
          <ProgressBar
            value={s.percent}
            marker={min}
            tone={risk ? "amber" : "cyan"}
            height={5}
          />
        </View>
        <View style={[styles.top, { alignItems: "center", marginTop: 10 }]}>
          <Text
            variant="monoSmall"
            style={{ flex: 1 }}
            color={risk ? colors.amber : colors.textDim}
          >
            {s.standing === "no-data"
              ? "No sessions held yet"
              : risk
                ? s.needToReach >= 10_000
                  ? `${pct(min)}% can no longer be reached this term`
                  : `Attend next ${s.needToReach} to reach ${pct(min)}%`
                : s.safeToMiss > 0
                  ? `Can miss ${s.safeToMiss} and stay ≥ ${pct(min)}%`
                  : `Don’t miss the next one`}
          </Text>
          <Text variant="monoSmall" color={colors.cyan}>
            Plan & history
          </Text>
          <ChevronRight color={colors.cyan} size={14} />
        </View>
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  alert: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 16 },
  top: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  big: { fontFamily: fonts.bold, fontSize: 26, letterSpacing: -0.8 },
  pctSign: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.textMuted,
    marginBottom: 4,
    marginLeft: 1,
  },
});
