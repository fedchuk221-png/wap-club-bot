const TEXTS = {
  ua: {
    welcome: "🔥 *WAP CLUB :: MOBILE DETAILING*\n\nІнженерний підхід до естетики вашого авто. Ми працюємо на виїзді у Кропивницькому — повністю автономно.\n\n👇 *Оберіть розділ:*",
    btn_detailing: "🚗 Виїзний детейлінг", btn_polishing: "✨ Полірування фар", btn_chips: "🛠 Ремонт сколів",
    btn_about: "ℹ️ Про клуб / Портфоліо", btn_contact: "💬 Зв'язок з інженером", btn_back: "🔙 У головне меню",
    btn_back_packages: "🔙 До пакетів", btn_order: "✅ Замовити (Крок 1: Контакт)", btn_share_phone: "📱 Поділитися номером телефону",
    ask_phone: "📞 Майже готово! Натисніть кнопку нижче, щоб поділитися номером телефону для зв'язку з майстром:",
    order_success: "✅ *Заявку підтверджено!*\n\nНомер заявки: `{orderId}`\n📞 Телефон: `{phone}`\n🛠 Послуга: *{service}*\n💰 Вартість: *{price} грн*\n📅 Дата заявки: {date}\n\n👨‍🔧 Головний інженер зв'яжеться з вами протягом 10 хвилин для узгодження часу виїзду.",
    processing: "⏳ *Оформлюємо заявку...*",
    about: "🛡 *WAP CLUB — Це не звичайна мийка*\n\nМи побудували автономний мобільний комплекс. Нам не потрібна ваша розетка чи водопровід — у нас на борту власний бак з водою на 150л, інверторна система на 72V та професійна хімія.\n\n*Наші стандарти:*\n🔹 Безконтактна делікатна мийка\n🔹 Використання пензлів та очищення важкодоступних місць\n🔹 Захисні покриття для кузова та пластику",
    detailing_intro: "🚗 *ВИЇЗНИЙ ДЕТЕЙЛІНГ — ОБЕРІТЬ ПАКЕТ*\n\nТри рівні залежно від того, скільки часу та уваги потрібно вашому авто:",
    pkg_basic_title: "🅱️ Базовий пакет",
    pkg_basic_desc: "🅱️ *БАЗОВИЙ ПАКЕТ*\n\n• Безконтактна мийка кузова\n• Очищення дисків\n• Протирання скла та дзеркал\n\n⏱ *Час:* ~40-60 хв\n💰 *Вартість:* від 1000 грн",
    pkg_standard_title: "🅂 Стандартний пакет",
    pkg_standard_desc: "🅂 *СТАНДАРТНИЙ ПАКЕТ*\n\n• Двофазна мийка, очищення пензлями\n• Прибирання салону, пилосос, скло\n• Консервація шин та пластику\n\n⏱ *Час:* 1.5 - 2.5 години\n💰 *Вартість:* від 1500 грн",
    pkg_exclusive_title: "🅴 Ексклюзивний пакет",
    pkg_exclusive_desc: "🅴 *ЕКСКЛЮЗИВНИЙ ПАКЕТ*\n\n• Все зі стандартного пакету\n• Глибоке очищення салону та шкіри\n• Захисне покриття кузова (віск/кераміка-спрей)\n• Полірування пластикових елементів салону\n\n⏱ *Час:* 3 - 4 години\n💰 *Вартість:* від 2200 грн",
    polishing_desc: "✨ *ГЛИБОКЕ ПОЛІРУВАННЯ ФАР*\n\n• Шліфування абразивами\n• Багатоступеневе полірування\n• Захисне покриття від ультрафіолету\n\n⏱ *Час:* ~1 година\n💰 *Вартість:* від 800 грн",
    chips_desc: "🛠 *РЕМОНТ СКОЛІВ ТА ТРІЩИН*\n\nТочкове усунення сколів до появи корозії.\n\n💰 *Вартість:* від 500 грн",
    contact_info: "📲 *Прямий зв'язок з майстром:*\nДля консультації напишіть нам напряму: @zabrodni_y",
    invalid_price: "⚠️ *Введіть коректну суму числом (наприклад: 1200):*"
  },
  en: {
    welcome: "🔥 *WAP CLUB :: MOBILE DETAILING*\n\nEngineering approach to your car's aesthetics. Mobile detailing in Kropyvnytskyi — fully autonomous.\n\n👇 *Choose section:*",
    btn_detailing: "🚗 Mobile Detailing", btn_polishing: "✨ Headlight Polishing", btn_chips: "🛠 Chip Repair",
    btn_about: "ℹ️ About Club / Portfolio", btn_contact: "💬 Contact Engineer", btn_back: "🔙 Main Menu",
    btn_back_packages: "🔙 Back to packages", btn_order: "✅ Order (Step 1: Contact)", btn_share_phone: "📱 Share Phone Number",
    ask_phone: "📞 Almost done! Tap the button below to share your phone number:",
    order_success: "✅ *Order confirmed!*\n\nOrder ID: `{orderId}`\n📞 Phone: `{phone}`\n🛠 Service: *{service}*\n💰 Price: *{price} UAH*\n📅 Order date: {date}\n\n👨‍🔧 Chief Engineer will contact you within 10 minutes to arrange the visit time.",
    processing: "⏳ *Processing your order...*",
    about: "🛡 *WAP CLUB — Premium Mobile Detailing*\n\nAutonomous mobile unit equipped with 150L water tank, 72V inverter system, and professional detailing products.\n\n*Our Standards:*\n🔹 Touchless delicate wash\n🔹 Detail brushes & thorough cleaning\n🔹 Protective coatings",
    detailing_intro: "🚗 *MOBILE DETAILING — CHOOSE A PACKAGE*\n\nThree levels depending on how much time and attention your car needs:",
    pkg_basic_title: "🅱️ Basic Package",
    pkg_basic_desc: "🅱️ *BASIC PACKAGE*\n\n• Touchless exterior wash\n• Wheel cleaning\n• Glass & mirror wipe-down\n\n⏱ *Time:* ~40-60 min\n💰 *Price:* from 1000 UAH",
    pkg_standard_title: "🅂 Standard Package",
    pkg_standard_desc: "🅂 *STANDARD PACKAGE*\n\n• Two-phase wash, detail brushes\n• Interior vacuum, glass cleaning\n• Tire & plastic dressing\n\n⏱ *Time:* 1.5 - 2.5 hours\n💰 *Price:* from 1500 UAH",
    pkg_exclusive_title: "🅴 Exclusive Package",
    pkg_exclusive_desc: "🅴 *EXCLUSIVE PACKAGE*\n\n• Everything in Standard\n• Deep interior & leather cleaning\n• Protective body coating (wax/ceramic spray)\n• Interior plastic polishing\n\n⏱ *Time:* 3 - 4 hours\n💰 *Price:* from 2200 UAH",
    polishing_desc: "✨ *HEADLIGHT POLISHING*\n\n• Abrasive sanding\n• Multi-step polishing\n• UV protection layer\n\n⏱ *Time:* ~1 hour\n💰 *Price:* from 800 UAH",
    chips_desc: "🛠 *CHIP & CRACK REPAIR*\n\nSpot repair of paint chips before corrosion occurs.\n\n💰 *Price:* from 500 UAH",
    contact_info: "📲 *Direct contact:*\nWrite directly to our engineer: @zabrodni_y",
    invalid_price: "⚠️ *Please enter a valid numeric amount (e.g. 1200):*"
  }
};

module.exports = TEXTS;
