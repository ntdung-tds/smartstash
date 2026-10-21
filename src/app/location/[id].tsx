import React, { useCallback, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, Alert, Modal, TextInput, FlatList,
} from 'react-native';
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { styles, Colors, ItemCard, LocationPickerModal, IconTile, IconPickerGrid, SectionTitle, type IconName } from '@/components/ui';
import { LOCATION_TYPE_COLORS, locationIconName, locationTypeLabel } from '@/theme';
import { useT } from '@/i18n';
import type { Item, Location } from '@/types';
import {
  getLocation, getBreadcrumb, breadcrumbText, listLocations, itemsInLocation,
  getDescendantLocationIds, moveLocation, renameLocation, setLocationIcon, softDeleteLocation, createLocation,
  listMediaForOwner,
} from '@/db/queries';
import { useAppStore } from '@/store/useAppStore';

export default function LocationDetailScreen() {
  const { t } = useT();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [loc, setLoc] = useState<Location | null>(null);
  const [crumb, setCrumb] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [children, setChildren] = useState<Location[]>([]);
  const [allLocations, setAllLocations] = useState<Location[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string | null>>({});
  const [crumbsMap, setCrumbsMap] = useState<Record<string, string>>({});
  const [showMove, setShowMove] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [showAddChild, setShowAddChild] = useState(false);
  const [text, setText] = useState('');
  const [renameIcon, setRenameIcon] = useState<IconName | null>(null);
  const [childIcon, setChildIcon] = useState<IconName | null>(null);
  const bump = useAppStore((s) => s.bump);

  const load = useCallback(async () => {
    if (!id) return;
    const l = await getLocation(id);
    setLoc(l);
    if (!l) return;
    setCrumb(breadcrumbText(await getBreadcrumb(l.id)));
    const its = await itemsInLocation(l.id, true);
    setItems(its);
    const all = await listLocations();
    setAllLocations(all);
    setChildren(all.filter((c) => c.parent_id === l.id));
    const tMap: Record<string, string | null> = {};
    const cMap: Record<string, string> = {};
    for (const it of its) {
      const media = await listMediaForOwner('ITEM', it.id);
      tMap[it.id] = media[0]?.thumbnail_uri ?? null;
      cMap[it.id] = breadcrumbText(await getBreadcrumb(it.location_id));
    }
    setThumbs(tMap);
    setCrumbsMap(cMap);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (!loc) {
    return (
      <View style={[styles.screen, styles.content]}>
        <Text style={styles.empty}>{t('ld.notFound')}</Text>
      </View>
    );
  }

  const depth = crumb ? crumb.split('>').length - 1 : 0;

  async function handleDelete() {
    const childCount = children.length;
    if (childCount > 0 || items.length > 0) {
      Alert.alert(t('ld.cantDeleteTitle'), t('ld.cantDeleteMsg'));
      return;
    }
    Alert.alert(t('ld.deleteTitle'), t('ld.deleteMsg', { name: loc!.name }), [
      { text: t('common.cancel') },
      {
        text: t('ld.delete'), style: 'destructive',
        onPress: async () => { await softDeleteLocation(loc!.id); bump(); router.back(); },
      },
    ]);
  }

  async function handleAddChild() {
    if (!text.trim()) return;
    const types: Location['type'][] = ['PROPERTY', 'ROOM', 'FURNITURE', 'CONTAINER'];
    const nextType = types[Math.min(3, depth + 1)];
    try {
      await createLocation({ name: text.trim(), type: nextType, parent_id: loc!.id, icon: childIcon });
      setText('');
      setChildIcon(null);
      setShowAddChild(false);
      bump();
      load();
    } catch (e) {
      Alert.alert(t('ld.createFailTitle'), e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, { paddingBottom: 40 }]}>
      <View style={{ gap: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <IconTile icon={locationIconName(loc)} color={LOCATION_TYPE_COLORS[loc.type]} size={54} iconSize={27} />
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>{loc.name}</Text>
            <Text style={styles.subtitle}>{locationTypeLabel(loc.type)} · {loc.qr_code}</Text>
          </View>
        </View>
        {!!crumb && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', backgroundColor: Colors.chipBg, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 6 }}>
            <Ionicons name="location" size={14} color={Colors.primary} />
            <Text style={{ fontSize: 13, color: Colors.primaryDark, fontWeight: '700' }}>{crumb}</Text>
          </View>
        )}
      </View>

      <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
        {depth < 3 && (
          <TouchableOpacity style={[styles.button, { paddingVertical: 10, paddingHorizontal: 14 }]} onPress={() => { setText(''); setChildIcon(null); setShowAddChild(true); }}>
            <Ionicons name="add" size={16} color="#fff" />
            <Text style={[styles.buttonText, { fontSize: 13 }]}>{t('ld.addChild')}</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={[styles.buttonSecondary, { paddingVertical: 10, paddingHorizontal: 14 }]} onPress={() => { setText(loc.name); setRenameIcon(loc.icon as IconName | null); setShowRename(true); }}>
          <Text style={[styles.buttonSecondaryText, { fontSize: 13 }]}>{t('ld.rename')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.buttonSecondary, { paddingVertical: 10, paddingHorizontal: 14 }]} onPress={() => setShowMove(true)}>
          <Text style={[styles.buttonSecondaryText, { fontSize: 13 }]}>{t('ld.move')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.buttonDanger, { paddingVertical: 10, paddingHorizontal: 14 }]} onPress={handleDelete}>
          <Text style={[styles.buttonDangerText, { fontSize: 13 }]}>{t('ld.delete')}</Text>
        </TouchableOpacity>
      </View>

      {children.length > 0 && (
        <View style={{ gap: 10 }}>
          <SectionTitle title={t('ld.childrenTitle')} color={Colors.teal} />
          {children.map((c) => (
            <TouchableOpacity key={c.id} style={[styles.card, { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 }]} onPress={() => router.push(`/location/${c.id}`)}>
              <IconTile icon={locationIconName(c)} color={LOCATION_TYPE_COLORS[c.type]} size={44} iconSize={22} />
              <Text style={{ flex: 1, fontSize: 15, fontWeight: '700', color: Colors.text }}>{c.name}</Text>
              <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: Colors.chipBg, alignItems: 'center', justifyContent: 'center' }}>
                <Ionicons name="chevron-forward" size={17} color={Colors.primary} />
              </View>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <View style={{ gap: 10 }}>
        <SectionTitle title={t('ld.itemsTitle')} subtitle={t('home.itemsCount', { n: items.length })} color={Colors.orange} />
        {items.length === 0 ? (
          <Text style={{ color: Colors.subtext, fontSize: 13 }}>{t('ld.emptyItems')}</Text>
        ) : (
          <FlatList
            data={items}
            keyExtractor={(i) => i.id}
            scrollEnabled={false}
            ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
            renderItem={({ item }) => (
              <ItemCard item={item} breadcrumb={crumbsMap[item.id] ?? ''} thumbUri={thumbs[item.id]} onPress={() => router.push(`/item/${item.id}`)} />
            )}
          />
        )}
      </View>

      <LocationPickerModal
        visible={showMove}
        locations={allLocations}
        title={t('ld.moveTitle')}
        excludeId={loc.id}
        onClose={() => setShowMove(false)}
        onSelect={async (target) => {
          try {
            // picker chọn vị trí cha mới; chặn hậu duệ bằng validateParent trong moveLocation
            const descendants = await getDescendantLocationIds(loc.id);
            if (descendants.includes(target.id)) {
              Alert.alert(t('ld.moveFailTitle'), t('ld.moveIntoChildMsg'));
              return;
            }
            await moveLocation(loc.id, target.id);
            bump();
            load();
          } catch (e) {
            Alert.alert(t('ld.moveFailTitle'), e instanceof Error ? e.message : String(e));
          }
        }}
      />

      <Modal visible={showRename || showAddChild} transparent animationType="fade" onRequestClose={() => { setShowRename(false); setShowAddChild(false); }}>
        <View style={styles.modalOverlay}>
          <View style={[styles.card, styles.modalCard, { gap: 14 }]}>
            <Text style={{ fontSize: 18, fontWeight: '800', color: Colors.text }}>{showRename ? t('ld.renameTitle') : t('ld.addChild')}</Text>
            <TextInput style={styles.input} value={text} onChangeText={setText} autoFocus />
            <View>
              <Text style={styles.label}>{t('locations.iconLabel')}</Text>
              <IconPickerGrid
                value={showRename ? renameIcon : childIcon}
                onChange={showRename ? setRenameIcon : setChildIcon}
                showDefaultOption
              />
            </View>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity style={[styles.buttonSecondary, { flex: 1 }]} onPress={() => { setShowRename(false); setShowAddChild(false); }}>
                <Text style={styles.buttonSecondaryText}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.button, { flex: 1 }]}
                onPress={async () => {
                  if (showRename) {
                    if (text.trim()) await renameLocation(loc.id, text.trim());
                    await setLocationIcon(loc.id, renameIcon);
                    setShowRename(false);
                  } else {
                    await handleAddChild();
                    return;
                  }
                  bump();
                  load();
                }}
              >
                <Text style={styles.buttonText}>{t('common.save')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}
