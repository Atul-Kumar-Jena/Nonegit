import NoticesScreen from '@kit/screens/NoticesScreen';

/** Every professor and admin can write notices (who they can reach depends on permissions). */
export default function Notices() {
  return <NoticesScreen canCompose />;
}
