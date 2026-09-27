import { useState } from 'react';
import { Plus } from 'lucide-react-native';
import { Screen } from '@kit/components/Screen';
import { Button, Text } from '@kit/components/ui';
import { colors } from '@kit/theme';
import { Header } from '@/components/forms';
import { BatchList, NewBatch } from '@/components/BatchList';
import { useBatches } from '@/queries';

/**
 * Batches, grouped by semester: batch → its students → its subjects.
 * Every teacher can create a batch and fill it; the creator and admins can change or remove things.
 */
export default function Batches() {
  const q = useBatches();
  const [open, setOpen] = useState(false);
  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <Header info="batches" title="Batches" right={<Button title="New" compact onPress={() => setOpen(true)} icon={<Plus color={colors.bg} size={15} />} />} />
      <Text variant="small">Semester → batch → its students → its subjects. Students added to a batch get its semester and every subject it takes.</Text>
      <BatchList onCreate={() => setOpen(true)} />
      {open ? <NewBatch onClose={() => setOpen(false)} /> : null}
    </Screen>
  );
}
