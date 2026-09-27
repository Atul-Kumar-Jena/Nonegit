import { useMemo } from 'react';
import PermissionsScreen from '@kit/screens/PermissionsScreen';
import { locationPermission, notificationPermission } from '@kit/lib/permissions';
import { batteryPermission } from '@kit/lib/battery';

export default function Permissions() {
  const items = useMemo(
    () => [
      locationPermission(
        'To set the classroom’s location when you start a QR class or save a room — only when you tap those buttons.',
        'You can still start QR classes in rooms whose location is already saved, and take registers; you can’t use “This phone, now” or save room locations.',
      ),
      notificationPermission(
        'So you hear (with sound) when you’re assigned to take a class, or one of your classes is moved or cancelled.',
        'You won’t be alerted about adjustments; you’ll only see them when you open the app.',
      ),
      batteryPermission(
        'So Android’s battery saver doesn’t hold back cover requests, class changes and reminders. It barely affects battery life.',
        'Requests and class reminders may arrive late, especially when the phone has been idle.',
      ),
    ],
    [],
  );
  return <PermissionsScreen appName="Attendly Institute" items={items} />;
}
