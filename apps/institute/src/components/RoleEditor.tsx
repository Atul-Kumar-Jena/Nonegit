import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { Crown, GraduationCap } from 'lucide-react-native';
import { STAFF_PERMISSIONS, type Person, type StaffPermission } from '@attendly/protocol';
import { Button, Card, Notice, Segmented, Text } from '@kit/components/ui';
import { useApi } from '@kit/state/session';
import { colors, radius } from '@kit/theme';
import { staffApi } from '@/api';
import { Checkbox, confirmAction } from './forms';

/**
 * Admins only: make someone an admin (principal / HOD — everything) or a professor, and pick which
 * extra powers a professor has. Saved at once; the person sees the change on their next screen.
 */
export function RoleEditor({ p, self }: { p: Person; self: boolean }) {
  const api = useApi();
  const qc = useQueryClient();
  const [role, setRole] = useState<'teacher' | 'admin'>(p.role === 'admin' ? 'admin' : 'teacher');
  const [perms, setPerms] = useState<Set<StaffPermission>>(new Set(p.permissions));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  useEffect(() => {
    setRole(p.role === 'admin' ? 'admin' : 'teacher');
    setPerms(new Set(p.permissions));
  }, [p.role, p.permissions.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  const changed = role !== p.role || (role === 'teacher' && (perms.size !== p.permissions.length || p.permissions.some((x) => !perms.has(x))));

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const next = await staffApi.setAccess(api, p.id, { role, permissions: role === 'admin' ? [] : [...perms] });
      qc.setQueryData(['staff', 'person', p.id], next);
      void qc.invalidateQueries({ queryKey: ['staff'] });
      setInfo(role === 'admin' ? `${p.fullName} is now an admin.` : `Saved. ${p.fullName} sees the change on their next screen.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t save.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={{ gap: 12 }}>
      <Segmented
        value={role}
        options={[
          { value: 'teacher', label: 'Professor' },
          { value: 'admin', label: 'Admin' },
        ]}
        onChange={setRole}
      />
      {role === 'admin' ? (
        <View style={styles.line}>
          <Crown color={colors.text} size={18} />
          <Text variant="small" style={{ flex: 1 }}>
            Admin (principal / HOD): everything — institution settings, people and roles, planner, phones — as well as teaching.
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.line}>
            <GraduationCap color={colors.text} size={18} />
            <Text variant="small" style={{ flex: 1 }}>
              Every professor runs their own classes, manages batches and sees all attendance reports. Also allow:
            </Text>
          </View>
          {STAFF_PERMISSIONS.map((x) => {
            const on = perms.has(x.key);
            return (
              <Pressable
                key={x.key}
                onPress={() =>
                  setPerms((cur) => {
                    const n = new Set(cur);
                    if (n.has(x.key)) n.delete(x.key);
                    else n.add(x.key);
                    return n;
                  })
                }
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={x.label}
                style={[styles.perm, on && { borderColor: colors.text }]}
              >
                <Checkbox checked={on} size={22} />
                <View style={{ flex: 1 }}>
                  <Text variant="bodyStrong">{x.label}</Text>
                  <Text variant="small">{x.detail}</Text>
                </View>
              </Pressable>
            );
          })}
        </>
      )}
      {error ? <Notice tone="red" message={error} onDismiss={() => setError(null)} /> : null}
      {info ? <Notice tone="green" message={info} onDismiss={() => setInfo(null)} /> : null}
      <Button
        title="Save role & permissions"
        onPress={() =>
          self && role !== 'admin'
            ? confirmAction('Stop being an admin?', 'You lose admin access at once (another admin can give it back).', 'Step down', () => void save(), true)
            : role === 'admin' && p.role !== 'admin'
              ? confirmAction(`Make ${p.fullName} an admin?`, 'Admins can do everything, including changing other people’s roles.', 'Make admin', () => void save())
              : void save()
        }
        loading={busy}
        disabled={!changed}
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  perm: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border },
});
