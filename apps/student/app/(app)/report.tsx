import { router } from 'expo-router';
import { View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react-native';
import { Screen } from '@kit/components/Screen';
import { DownloadCard, DownloadRow } from '@kit/components/Download';
import { InfoButton } from '@kit/components/Features';
import { Card, IconButton, Loading, SectionLabel, Text } from '@kit/components/ui';
import { studentReportDoc } from '@kit/lib/export';
import { pct } from '@kit/lib/format';
import { useApi } from '@kit/state/session';
import { colors } from '@kit/theme';
import { offlineReport } from '@/lib/report-offline';
import { qk, useMyReport, useSubjects } from '@/state/queries';

/** Download my attendance: everything together, or one subject with every class. */
export default function MyReport() {
  const api = useApi();
  const qc = useQueryClient();
  const all = useMyReport();
  const subs = useSubjects();
  const subjects = all.data?.subjects ?? subs.data?.subjects ?? [];
  const total = all.data?.total;

  return (
    <Screen onRefresh={() => void all.refetch()} refreshing={all.isRefetching}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <IconButton label="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/home'))}>
          <ArrowLeft color={colors.text} size={18} />
        </IconButton>
        <Text variant="heading" style={{ flex: 1 }}>
          Download attendance
        </Text>
        <InfoButton
          title="Download attendance"
          text={[
            'Save or share your attendance as a PDF (to print or send) or an Excel sheet.',
            'All subjects: every subject plus your cumulative total.',
            'One subject: that subject with every class — date, time, present/absent and how it was marked.',
            'Works offline too: without internet the file uses the latest data saved on this phone and says how old it is.',
          ]}
        />
      </View>

      {total ? (
        <Card style={{ marginTop: 18 }}>
          <Text variant="label">Overall this term</Text>
          <Text variant="title" style={{ marginTop: 6 }}>
            {pct(total.percent)}%
          </Text>
          <Text variant="small">{`${total.attended} of ${total.held} classes · ${subjects.length} subjects`}</Text>
        </Card>
      ) : null}

      <View style={{ marginTop: 14 }}>
        <DownloadCard
          title="All subjects (cumulative)"
          hint="Every subject and your overall %"
          queryKey={qk.report()}
          fetch={() => api.report()}
          toDoc={studentReportDoc}
          fallback={() => offlineReport(qc)}
        />
      </View>

      <SectionLabel>One subject, class by class</SectionLabel>
      {all.isPending && subs.isPending ? (
        <Loading />
      ) : subjects.length === 0 ? (
        <Card>
          <Text variant="small">No subjects yet.</Text>
        </Card>
      ) : (
        <Card style={{ paddingVertical: 4 }}>
          {subjects.map((s) => (
            <DownloadRow
              key={s.courseId}
              label={s.code}
              detail={`${pct(s.percent)}% · ${s.attended}/${s.held}${s.title !== s.code ? ` · ${s.title}` : ''}`}
              queryKey={qk.report(s.courseId)}
              fetch={() => api.report(s.courseId)}
              toDoc={studentReportDoc}
              fallback={() => offlineReport(qc, s.courseId)}
            />
          ))}
        </Card>
      )}
    </Screen>
  );
}
