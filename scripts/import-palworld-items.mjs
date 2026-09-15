import fs from 'node:fs';
import path from 'node:path';

const sourcePath = path.resolve(process.argv[2] || 'config/palworld-items-source.json');
const outputPath = path.resolve(process.argv[3] || 'config/palworld-items.json');

if (!fs.existsSync(sourcePath)) {
  throw new Error(`Source JSON not found: ${sourcePath}`);
}

const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const entries = Array.isArray(source)
  ? source.map((item) => [item.id ?? item.ItemID, item])
  : Object.entries(source);

const items = entries
  .map(([id, value]) => ({
    id: String(id ?? '').trim(),
    name: String(value?.localized_name ?? value?.name ?? id ?? '').trim(),
    description: String(value?.description ?? '').replace(/<[^>]+>/g, '').trim(),
    category: categoryFor(String(id ?? '')),
    verified: false,
    source: 'Palworld localization/item export'
  }))
  .filter((item) => item.id && item.name)
  .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
  .sort((a, b) => a.id.localeCompare(b.id));

const output = {
  version: 1,
  source: 'Palworld localization/item export',
  complete: true,
  verifiedAgainstLiveServer: false,
  note: 'IDs and localized metadata came from the supplied export. Delivery still requires live verification against the active Palworld build.',
  items
};

fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(`Imported ${items.length} Palworld items into ${outputPath}`);

function categoryFor(id) {
  if (/^Accessory|^Head|Armor|Helmet|Shield|Outfit|ClothArmor|FurArmor|CopperArmor|IronArmor|PlasticArmor|StealArmor|SFArmor/.test(id)) return 'Equipment';
  if (/^Blueprint/.test(id)) return 'Blueprints';
  if (/^PalSphere|Sphere|^PalEgg/.test(id)) return 'Capture';
  if (/^SkillCard|^SkillUnlock|^Otomo/.test(id)) return 'Pal Skills';
  if (/^Baked|^Cake|^Curry|^Food|^Grilled|^Meal|^Omelet|^Pizza|^Salad|^Soup|^Stew|^Bread|^Berries|^Milk|^Meat/.test(id)) return 'Food';
  if (/^Potion|^Medicine|^Medicines|^Elixir|^Remedy|^Herbs/.test(id)) return 'Medicine';
  if (/^Arrow|Bullet|Ammo|Gun|Rifle|Shotgun|Bow|Spear|Sword|Axe|Pickaxe|Launcher|Grenade|Katana|Bat|Torch/.test(id)) return 'Weapons';
  if (/^Pal|^Boss|^Relic|^Fruit|^Rankup|^ExpBoost|^WorkSuitability/.test(id)) return 'Pal Items';
  if (/^Wood|^Stone|Ore|Ingot|^Coal|^Fiber|^Leather|^Cloth|^Metal|^Quartz|^Oil|^Polymer|^Cement|^Carbon|^Wool/.test(id)) return 'Resources';
  if (/Money|Coin|Gold|Treasure|Ruby|Diamond|Sapphire|Emerald/.test(id)) return 'Currency';
  return 'Other';
}
