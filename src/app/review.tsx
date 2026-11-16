import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useEffect, useState, type ComponentProps } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  deleteTransaction,
  findByRefNo,
  getTransaction,
  insertTransaction,
  updateTransaction,
  type TransactionInput,
} from '../lib/db';
import { prettyDate, theme } from '../lib/format';
import { deleteReceiptImage, isStoredReceipt, persistReceiptImage } from '../lib/images';
import { recognizeText } from '../lib/ocr';
import { formatDateTime, parseGcashReceipt, TXN_TYPES, type TxnType } from '../lib/parseGcash';
import { pickReceipt } from '../lib/pickReceipt';

type Form = {
  type: TxnType;
  amount: string;
  refNo: string;
  txnDate: string;
  recipient: string;
  phone: string;
  note: string;
};

const emptyForm = (): Form => ({
  type: 'Send Money',
  amount: '',
  refNo: '',
  txnDate: formatDateTime(new Date()),
  recipient: '',
  phone: '',
  note: '',
});

export default function Review() {
  const db = useSQLiteContext();
  const params = useLocalSearchParams<{ uri?: string; id?: string }>();
  const editingId = params.id ? Number(params.id) : null;

  const [imageUri, setImageUri] = useState(params.uri ?? '');
  const [rawText, setRawText] = useState('');
  const [form, setForm] = useState<Form>(emptyForm);
  // A new receipt starts out "scanning"; the effect below kicks off the OCR.
  const [scanning, setScanning] = useState(Boolean(params.uri));
  const [notice, setNotice] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  /** Runs OCR on the image and fills the form. Caller sets `scanning` beforehand. */
  const runScan = async (uri: string) => {
    const res = await recognizeText(uri);
    setScanning(false);
    if (!res.ok) {
      setNotice(res.error);
      return;
    }
    setRawText(res.text);
    const p = parseGcashReceipt(res.text);
    setForm((f) => ({
      ...f,
      type: p.type === 'Other' ? f.type : p.type,
      amount: p.amount !== null ? p.amount.toFixed(2) : f.amount,
      refNo: p.refNo || f.refNo,
      txnDate: p.txnDate || f.txnDate,
      recipient: p.recipient || f.recipient,
      phone: p.phone || f.phone,
    }));
    const missing = [
      p.amount === null && 'amount',
      !p.refNo && 'reference no.',
      !p.txnDate && 'date',
    ].filter(Boolean);
    setNotice(
      missing.length
        ? `Couldn't find: ${missing.join(', ')}. Please fill in or check below.`
        : 'Details read from the receipt. Please double-check before saving.',
    );
  };

  const scan = (uri: string) => {
    setScanning(true);
    setNotice('');
    runScan(uri);
  };

  // New receipt: read it. Existing transaction: load it.
  useEffect(() => {
    if (params.uri) {
      // runScan only sets state after awaiting the OCR result, so this doesn't cascade renders.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      runScan(params.uri);
    } else if (editingId !== null) {
      getTransaction(db, editingId).then((t) => {
        if (!t) return;
        setImageUri(t.image_uri);
        setRawText(t.raw_text);
        setForm({
          type: t.type,
          amount: t.amount.toFixed(2),
          refNo: t.ref_no,
          txnDate: t.txn_date,
          recipient: t.recipient,
          phone: t.phone,
          note: t.note,
        });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const replaceImage = async (source: 'camera' | 'gallery') => {
    const uri = await pickReceipt(source);
    if (!uri) return;
    setImageUri(uri);
    scan(uri);
  };

  const doSave = async () => {
    setSaving(true);
    try {
      let storedUri = imageUri;
      if (imageUri && !isStoredReceipt(imageUri)) {
        storedUri = await persistReceiptImage(imageUri);
      }
      const data: TransactionInput = {
        type: form.type,
        amount: parseFloat(form.amount.replace(/,/g, '')),
        ref_no: form.refNo.replace(/\s+/g, ''),
        recipient: form.recipient.trim(),
        phone: form.phone.trim(),
        txn_date: form.txnDate.trim(),
        note: form.note.trim(),
        image_uri: storedUri,
        raw_text: rawText,
      };
      if (editingId !== null) {
        const old = await getTransaction(db, editingId);
        await updateTransaction(db, editingId, data);
        if (old && old.image_uri !== storedUri) deleteReceiptImage(old.image_uri);
      } else {
        await insertTransaction(db, data);
      }
      router.back();
    } catch (e) {
      Alert.alert('Could not save', e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    const amount = parseFloat(form.amount.replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) {
      Alert.alert('Check amount', 'Please enter a valid amount.');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(form.txnDate.trim())) {
      Alert.alert('Check date', 'Use the format YYYY-MM-DD HH:mm, e.g. 2026-11-17 17:36.');
      return;
    }
    const dup = await findByRefNo(db, form.refNo.replace(/\s+/g, ''), editingId ?? undefined);
    if (dup) {
      Alert.alert(
        'Already recorded?',
        `Ref ${dup.ref_no} was already saved on ${prettyDate(dup.txn_date)} (${dup.recipient || dup.type}).`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Save anyway', onPress: doSave },
        ],
      );
      return;
    }
    doSave();
  };

  const remove = () => {
    if (editingId === null) return;
    Alert.alert('Delete transaction?', 'This also deletes the saved receipt image.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await deleteTransaction(db, editingId);
          deleteReceiptImage(imageUri);
          router.back();
        },
      },
    ]);
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={100}
    >
      <Stack.Screen options={{ title: editingId !== null ? 'Transaction' : 'New Transaction' }} />
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        {imageUri ? (
          <Image source={{ uri: imageUri }} style={styles.image} resizeMode="contain" />
        ) : (
          <View style={[styles.image, styles.noImage]}>
            <Text style={{ color: theme.muted }}>No receipt image</Text>
          </View>
        )}

        <View style={styles.imageActions}>
          <Pressable onPress={() => replaceImage('camera')}>
            <Text style={styles.link}>Retake</Text>
          </Pressable>
          <Pressable onPress={() => replaceImage('gallery')}>
            <Text style={styles.link}>Choose another</Text>
          </Pressable>
          {imageUri ? (
            <Pressable onPress={() => scan(imageUri)}>
              <Text style={styles.link}>Re-scan</Text>
            </Pressable>
          ) : null}
        </View>

        {scanning ? (
          <View style={styles.notice}>
            <ActivityIndicator color={theme.blue} />
            <Text style={styles.noticeText}>Reading receipt…</Text>
          </View>
        ) : notice ? (
          <View style={styles.notice}>
            <Text style={styles.noticeText}>{notice}</Text>
          </View>
        ) : null}

        <Text style={styles.label}>Type</Text>
        <View style={styles.chips}>
          {TXN_TYPES.map((t) => (
            <Pressable
              key={t}
              onPress={() => set('type', t)}
              style={[styles.chip, form.type === t && styles.chipActive]}
            >
              <Text style={[styles.chipText, form.type === t && styles.chipTextActive]}>{t}</Text>
            </Pressable>
          ))}
        </View>

        <Field label="Amount (₱)" value={form.amount} onChangeText={(v) => set('amount', v)} keyboardType="decimal-pad" placeholder="0.00" />
        <Field label="Reference No." value={form.refNo} onChangeText={(v) => set('refNo', v)} keyboardType="number-pad" placeholder="13-digit ref no." />
        <Field label="Date & time (YYYY-MM-DD HH:mm)" value={form.txnDate} onChangeText={(v) => set('txnDate', v)} placeholder="2026-11-17 17:36" />
        <Field label="Name / Merchant" value={form.recipient} onChangeText={(v) => set('recipient', v)} placeholder="e.g. JU** DE* C." />
        <Field label="Mobile number" value={form.phone} onChangeText={(v) => set('phone', v)} keyboardType="phone-pad" placeholder="+63 9XX XXX XXXX" />
        <Field label="Note" value={form.note} onChangeText={(v) => set('note', v)} placeholder="What was this for?" multiline />

        <Pressable style={[styles.saveBtn, saving && { opacity: 0.6 }]} onPress={save} disabled={saving || scanning}>
          <Text style={styles.saveText}>{editingId !== null ? 'Save Changes' : 'Save Transaction'}</Text>
        </Pressable>

        {editingId !== null ? (
          <Pressable style={styles.deleteBtn} onPress={remove}>
            <Text style={styles.deleteText}>Delete</Text>
          </Pressable>
        ) : null}

        {rawText ? (
          <Pressable onPress={() => setShowRaw((s) => !s)}>
            <Text style={[styles.link, { marginTop: 8 }]}>
              {showRaw ? 'Hide' : 'Show'} scanned text
            </Text>
          </Pressable>
        ) : null}
        {showRaw ? <Text style={styles.raw}>{rawText}</Text> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field(props: ComponentProps<typeof TextInput> & { label: string }) {
  const { label, style, ...rest } = props;
  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={[styles.input, rest.multiline && { minHeight: 70, textAlignVertical: 'top' }, style]}
        placeholderTextColor={theme.muted}
        {...rest}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 12, paddingBottom: 48 },
  image: { width: '100%', height: 320, borderRadius: 12, backgroundColor: '#0B1B33' },
  noImage: { alignItems: 'center', justifyContent: 'center', backgroundColor: theme.border },
  imageActions: { flexDirection: 'row', justifyContent: 'center', gap: 24 },
  link: { color: theme.blue, fontWeight: '600', textAlign: 'center' },
  notice: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    backgroundColor: '#E6F0FF',
    borderRadius: 10,
    padding: 12,
  },
  noticeText: { color: theme.blueDark, flex: 1 },
  label: { color: theme.muted, fontSize: 13, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.card,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipActive: { backgroundColor: theme.blue, borderColor: theme.blue },
  chipText: { color: theme.text, fontSize: 13 },
  chipTextActive: { color: '#fff', fontWeight: '700' },
  input: {
    backgroundColor: theme.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: theme.text,
  },
  saveBtn: {
    backgroundColor: theme.blue,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  saveText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  deleteBtn: { paddingVertical: 12, alignItems: 'center' },
  deleteText: { color: theme.red, fontWeight: '700' },
  raw: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12,
    color: theme.muted,
    backgroundColor: theme.card,
    padding: 12,
    borderRadius: 8,
  },
});
