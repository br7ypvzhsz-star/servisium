# Synthetic demo venue for UI tests and store screenshots. Not real data.
REST=[{"id":1,"name":"Demo Bistro","city":"Київ","address":"вул. Прикладна, 1","status":"active","subscription_status":"active","currency":"UAH","locale":"uk-UA","timezone":"Europe/Kyiv"}]
PROFILE={"is_platform_admin":False,"staff":[{"id":1,"name":"Олена","role":"ADMIN","restaurant_id":1,"status":"active"}]}
def item(i,name,cat,typ,price,desc,unit,all_=(),conf=True):
    return {"id":i,"restaurant_id":1,"name":name,"category":cat,"type":typ,"price":price,"description":desc,"weight":unit,"unit":unit,
            "allergens":list(all_),"allergens_status":"confirmed" if conf else "unknown","status":"active","photo_url":None,"currency":"UAH"}
MENU=[
 item(1,"Салат з печеним буряком і козячим сиром","Салати","Кухня",245,"Печений буряк, козячий сир, руккола, горіхи, медова заправка","220 г",["milk","tree_nuts"]),
 item(2,"Цезар з куркою","Салати","Кухня",265,"Ромен, курка гриль, пармезан, крутони, соус цезар","250 г",["gluten","eggs","milk","fish"]),
 item(3,"Борщ з пампушками","Супи","Кухня",185,"Український борщ, сметана, пампушки з часником","350 / 80 г",["gluten","milk","celery"]),
 item(4,"Крем-суп з гарбуза","Супи","Кухня",165,"Гарбуз, вершки, гарбузове насіння","300 г",["milk"]),
 item(5,"Стейк рібай","Гаряче","Кухня",690,"Яловичина зернової відгодівлі, соус демі-гляс","300 г",[]),
 item(6,"Філе лосося на грилі","Гаряче","Кухня",540,"Лосось, спаржа, лимонний соус","220 г",["fish","milk"]),
 item(7,"Вареники з картоплею","Гаряче","Кухня",175,"Картопля, смажена цибуля, сметана","280 г",["gluten","milk"]),
 item(8,"Чізкейк Нью-Йорк","Десерти","Кухня",185,"Вершковий сир, пісочна основа, ягідний соус","150 г",["gluten","eggs","milk"]),
 item(9,"Апероль Шприц","Коктейлі","Бар",220,"Aperol, просекко, содова, апельсин","250 мл",[]),
 item(10,"Негроні","Коктейлі","Бар",240,"Джин, червоний вермут, біттер","120 мл",[]),
 item(11,"Еспресо","Кава","Бар",60,"","30 мл",[]),
 item(12,"Капучино","Кава","Бар",85,"","250 мл",["milk"]),
 item(13,"Лимонад маракуя","Безалкогольні","Бар",110,"Маракуя, лайм, содова","400 мл",[]),
 item(14,"Вино біле сухе, келих","Вино","Бар",160,"Шардоне","150 мл",["sulphites"]),
]
ONBOARD={"restaurant":{"name":"Demo Bistro","has_city":True},"hall_tables":14,"tables":14,"staff_active":6,"staff_waiters":4,
 "menu_items":14,"menu_with_price":14,"categories":8,"kitchen_items":8,"ingredients_confirmed":12,"prep_time_set":8,
 "allergens_confirmed":14,"with_photo":9,"bar_items":6,"bar_with_photo":4}
