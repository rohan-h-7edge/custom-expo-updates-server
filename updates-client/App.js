import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

export default function App() {
  return (
    <View style={styles.container}>
      <View style={styles.badge}>
        <Text style={styles.badgeText}>LIVE UPDATE</Text>
      </View>

      <Text style={styles.emoji}>🔥</Text>
      <Text style={styles.title}>Hi Rohan!</Text>
      <Text style={styles.subtitle}>
        How are you? This message was shipped over-the-air via AWS Lambda + CloudFront — no app store, no waiting.
      </Text>

      <View style={styles.divider} />

      <View style={styles.infoRow}>
        <Text style={styles.infoLabel}>Server</Text>
        <Text style={styles.infoValue}>AWS Lambda</Text>
      </View>
      <View style={styles.infoRow}>
        <Text style={styles.infoLabel}>CDN</Text>
        <Text style={styles.infoValue}>CloudFront</Text>
      </View>
      <View style={styles.infoRow}>
        <Text style={styles.infoLabel}>Storage</Text>
        <Text style={styles.infoValue}>S3</Text>
      </View>
      <View style={styles.infoRow}>
        <Text style={styles.infoLabel}>Signing</Text>
        <Text style={styles.infoValue}>Secrets Manager</Text>
      </View>

<StatusBar style="light" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f172a',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
  },
  badge: {
    backgroundColor: '#166534',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 20,
    marginBottom: 24,
  },
  badgeText: {
    color: '#4ade80',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  emoji: {
    fontSize: 56,
    marginBottom: 16,
  },
  title: {
    fontSize: 36,
    fontWeight: '800',
    color: '#f1f5f9',
    marginBottom: 12,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 15,
    color: '#94a3b8',
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 32,
  },
  divider: {
    width: '100%',
    height: 1,
    backgroundColor: '#1e293b',
    marginBottom: 24,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  infoLabel: {
    color: '#64748b',
    fontSize: 14,
  },
  infoValue: {
    color: '#38bdf8',
    fontSize: 14,
    fontWeight: '600',
  },
});
