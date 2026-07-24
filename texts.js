const TEXTS = {
  ru: {
    welcome: "🔥 *WAP CLUB :: MOBILE DETAILING*\n\nИнженерный подход к эстетике вашего автомобиля. Мы работаем на выезде в Кропивницком — полностью автономно.\n\n👇 *Выберите раздел:*",
    btn_detailing: "🚗 Выездной детейлинг", btn_polishing: "✨ Полировка фар", btn_chips: "🛠 Ремонт сколов",
    btn_about: "ℹ️ О клубе / Портфолио", btn_contact: "💬 Связь с инженером", btn_back: "🔙 В главное меню",
    btn_order: "✅ Заказать (Шаг 1: Контакт)", btn_share_phone: "📱 Поделиться номером телефона",
    ask_phone: "📞 Почти готово! Нажмите кнопку ниже, чтобы поделиться номером телефона для связи с мастером:",
    order_success: "✅ *Заявка успешно оформлена!*\n\nНомер заявки: `{orderId}`\nТелефон: `{phone}`\nУслуга: *{service}*\n\n👨‍🔧 Главный инженер свяжется с вами в течение 10 минут для подтверждения выезда.",
    about: "🛡 *WAP CLUB — Это не обычная мойка*\n\nМы построили автономный мобильный комплекс. Нам не нужна ваша розетка или водопровод — у нас на борту собственный бак с водой на 150л, инверторная система на 72V и профессиональная химия.\n\n*Наши стандарты:*\n🔹 Бесконтактная деликатная мойка\n🔹 Использование кистей и труднодоступной чистки\n🔹 Защитные покрытия для кузова и пластика",
    detailing_desc: "🚗 *ВЫЕЗДНОЙ ДЕТЕЙЛИНГ КУЗОВА И САЛОНА*\n\n• Двухфазная мойка, очистка кистями\n• Уборка салона, пылесос, стекла\n• Консервация шин и пластика\n\n⏱ *Время:* 1.5 - 2.5 часа\n💰 *Стоимость:* от 1500 грн",
    polishing_desc: "✨ *ГЛУБОКАЯ ПОЛИРОВКА ФАР*\n\n• Шлифовка абразивами\n• Многоступенчатая полировка\n• Защитное покрытие от ультрафиолета\n\n⏱ *Время:* ~1 час\n💰 *Стоимость:* от 800 грн",
    chips_desc: "🛠 *РЕМОНТ СКОЛОВ И ТРЕЩИН*\n\nТочечное устранение сколов до появления коррозии.\n\n💰 *Стоимость:* от 500 грн",
    contact_info: "📲 *Прямая связь с мастером:*\nДля консультации напишите нам напрямую: @zabrodni_y",
    invalid_price: "⚠️ *Введите корректную сумму числом (например: 1200):*"
  },
  ua: {
    welcome: "🔥 *WAP CLUB :: MOBILE DETAILING*\n\nІнженерний підхід до естетики вашого авто. Ми працюємо на виїзді у Кропивницькому — повністю автономно.\n\n👇 *Оберіть розділ:*",
    btn_detailing: "🚗 Виїзний детейлінг", btn_polishing: "✨ Полірування фар", btn_chips: "🛠 Ремонт сколів",
    btn_about: "ℹ️ Про клуб / Портфоліо", btn_contact: "💬 Зв'язок з інженером", btn_back: "🔙 У головне меню",
    btn_order: "✅ Замовити (Крок 1: Контакт)", btn_share_phone: "📱 Поділитися номером телефону",
    ask_phone: "📞 Майже готово! Натисніть кнопку нижче, щоб поділитися номером телефону для зв'язку з майстром:",
    order_success: "✅ *Заявку успішно оформлено!*\n\nНомер заявки: `{orderId}`\nТелефон: `{phone}`\nПослуга: *{service}*\n\n👨‍🔧 Головний інженер зв'яжеться з вами протягом 10 хвилин для підтвердження виїзду.",
    about: "🛡 *WAP CLUB — Це не звичайна мийка*\n\nМи побудували автономний мобільний комплекс. Нам не потрібна ваша розетка чи водопровід — у нас на борту власний бак з водою на 150л, інверторна система на 72V та професійна хімія.\n\n*Наші стандарти:*\n🔹 Безконтактна делікатна мийка\n🔹 Використання пензлів та очищення важкодоступних місць\n🔹 Захисні покриття для кузова та пластику",
    detailing_desc: "🚗 *ВИЇЗНИЙ ДЕТЕЙЛІНГ КУЗОВА ТА САЛОНУ*\n\n• Двофазна мийка, очищення пензлями\n• Прибирання салону, пилосос, скло\n• Консервація шин та пластику\n\n⏱ *Час:* 1.5 - 2.5 години\n💰 *Вартість:* від 1500 грн",
    polishing_desc: "✨ *ГЛИБОКЕ ПОЛІРУВАННЯ ФАР*\n\n• Шліфування абразивами\n• Багатоступеневе полірування\n• Захисне покриття від ультрафіолету\n\n⏱ *Час:* ~1 година\n💰 *Вартість:* від 800 грн",
    chips_desc: "🛠 *РЕМОНТ СКОЛІВ ТА ТРІЩИН*\n\nТочкове усунення сколів до появи корозії.\n\n💰 *Вартість:* від 500 грн",
    contact_info: "📲 *Прямий зв'язок з майстром:*\nДля консультації напишіть нам напряму: @zabrodni_y",
    invalid_price: "⚠️ *Введіть коректну суму числом (наприклад: 1200):*"
  },
  en: {
    welcome: "🔥 *WAP CLUB :: MOBILE DETAILING*\n\nEngineering approach to your car's aesthetics. Mobile detailing in Kropyvnytskyi — fully autonomous.\n\n👇 *Choose section:*",
    btn_detailing: "🚗 Mobile Detailing", btn_polishing: "✨ Headlight Polishing", btn_chips: "🛠 Chip Repair",
    btn_about: "ℹ️ About Club / Portfolio", btn_contact: "💬 Contact Engineer", btn_back: "🔙 Main Menu",
    btn_order: "✅ Order (Step 1: Contact)", btn_share_phone: "📱 Share Phone Number",
    ask_phone: "📞 Almost done! Tap the button below to share your phone number:",
    order_success: "✅ *Order successfully placed!*\n\nOrder ID: `{orderId}`\nPhone: `{phone}`\nService: *{service}*\n\n👨‍🔧 Chief Engineer will contact you within 10 minutes to confirm.",
    about: "🛡 *WAP CLUB — Premium Mobile Detailing*\n\nAutonomous mobile unit equipped with 150L water tank, 72V inverter system, and professional detailing products.\n\n*Our Standards:*\n🔹 Touchless delicate wash\n🔹 Detail brushes & thorough cleaning\n🔹 Protective coatings",
    detailing_desc: "🚗 *MOBILE EXTERIOR & INTERIOR DETAILING*\n\n• Two-phase wash, detail brushes\n• Interior vacuum, glass cleaning\n• Tire & plastic dressing\n\n⏱ *Time:* 1.5 - 2.5 hours\n💰 *Price:* from 1500 UAH",
    polishing_desc: "✨ *HEADLIGHT POLISHING*\n\n• Abrasive sanding\n• Multi-step polishing\n• UV protection layer\n\n⏱ *Time:* ~1 hour\n💰 *Price:* from 800 UAH",
    chips_desc: "🛠 *CHIP & CRACK REPAIR*\n\nSpot repair of paint chips before corrosion occurs.\n\n💰 *Price:* from 500 UAH",
    contact_info: "📲 *Direct contact:*\nWrite directly to our engineer: @zabrodni_y",
    invalid_price: "⚠️ *Please enter a valid numeric amount (e.g. 1200):*"
  }
};

module.exports = TEXTS;
