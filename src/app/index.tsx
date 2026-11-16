import { router, useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import {
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { listTransactions, monthSummary, type Summary, type Transaction } from '../lib/db';
import { isIncoming, peso, prettyDate, theme } from '../lib/format';
import { pickReceipt, type ReceiptSource } from '../lib/pickReceipt';

const currentMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

export default function Home() {
  const db = useSQLiteContext();
  const [items, setItems] = useState<Transaction[]>([]);
  const [summary, setSummary] = useState<Summary>({ count: 0, inflow: 0, outflow: 0 });
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    const [rows, sum] = await Promise.all([
      listTransactions(db, search),
      monthSummary(db, currentMonth()),
    ]);
    setItems(rows);
    setSummary(sum);
  }, [db, search]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const addFrom = async (source: ReceiptSource) => {
    const uri = await pickReceipt(source);
    if (uri) router.push({ pathname: '/review', params: { uri } });
  };

  return (
    <View style={styles.container}>
      <View style={styles.summary}>
        <Text style={styles.summaryLabel}>This month · {summary.count} transactions</Text>
        <View style={styles.summaryRow}>
          <View>
            <Text style={styles.summarySub}>Money out</Text>
            <Text style={styles.summaryValue}>{peso(summary.outflow)}</Text>
          </View>
          <View>
            <Text style={styles.summarySub}>Money in</Text>
            <Text style={styles.summaryValue}>{peso(summary.inflow)}</Text>
          </View>
        </View>
      </View>

      <View style={styles.actions}>
        <Pressable style={[styles.actionBtn, styles.primary]} onPress={() => addFrom('camera')}>
          <Text style={styles.actionIcon}>📷</Text>
          <Text style={styles.primaryText}>Capture Receipt</Text>
        </Pressable>
        <Pressable style={[styles.actionBtn, styles.secondary]} onPress={() => addFrom('gallery')}>
          <Text style={styles.actionIcon}>🖼️</Text>
          <Text style={styles.secondaryText}>From Gallery</Text>
        </Pressable>
      </View>

      <TextInput
        style={styles.search}
        placeholder="Search name, ref no., note…"
        placeholderTextColor={theme.muted}
        value={search}
        onChangeText={setSearch}
        returnKeyType="search"
      />

      <FlatList
        data={items}
        keyExtractor={(t) => String(t.id)}
        contentContainerStyle={{ paddingBottom: 32 }}
        ListEmptyComponent={
          <Text style={styles.empty}>
            No transactions yet.{'\n'}Capture a GCash receipt or pick a screenshot from your gallery.
          </Text>
        }
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() => router.push({ pathname: '/review', params: { id: String(item.id) } })}
          >
            {item.image_uri ? (
              <Image source={{ uri: item.image_uri }} style={styles.thumb} />
            ) : (
              <View style={[styles.thumb, styles.thumbEmpty]} />
            )}
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {item.recipient || item.type}
              </Text>
              <Text style={styles.rowSub} numberOfLines={1}>
                {item.type} · {prettyDate(item.txn_date)}
              </Text>
              {item.ref_no ? <Text style={styles.rowSub}>Ref {item.ref_no}</Text> : null}
            </View>
            <Text style={[styles.amount, { color: isIncoming(item.type) ? theme.green : theme.red }]}>
              {isIncoming(item.type) ? '+' : '−'}
              {peso(item.amount)}
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 12 },
  summary: { backgroundColor: theme.blueDark, borderRadius: 16, padding: 16 },
  summaryLabel: { color: '#CFE3FF', fontSize: 13 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  summarySub: { color: '#CFE3FF', fontSize: 12 },
  summaryValue: { color: '#fff', fontSize: 22, fontWeight: '700' },
  actions: { flexDirection: 'row', gap: 12 },
  actionBtn: { flex: 1, borderRadius: 14, paddingVertical: 14, alignItems: 'center', gap: 4 },
  actionIcon: { fontSize: 22 },
  primary: { backgroundColor: theme.blue },
  primaryText: { color: '#fff', fontWeight: '700' },
  secondary: { backgroundColor: theme.card, borderWidth: 1, borderColor: theme.blue },
  secondaryText: { color: theme.blue, fontWeight: '700' },
  search: {
    backgroundColor: theme.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: theme.text,
  },
  empty: { textAlign: 'center', color: theme.muted, marginTop: 40, lineHeight: 22 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: theme.card,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
  },
  thumb: { width: 44, height: 64, borderRadius: 6, backgroundColor: theme.border },
  thumbEmpty: { opacity: 0.5 },
  rowTitle: { fontWeight: '700', color: theme.text, fontSize: 15 },
  rowSub: { color: theme.muted, fontSize: 12, marginTop: 2 },
  amount: { fontWeight: '700', fontSize: 15 },
});
