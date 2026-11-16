-- Diagnostic : le livrable est un PDF (une slide par page, paysage 16:9), prêt à envoyer ou à projeter.
-- Remplacement ciblé dans le prompt de diagnostic : seules les phrases d'origine qui parlaient du .pptx changent.
-- Un prompt déjà réécrit par l'utilisateur garde son texte ; la consigne du connecteur (open_diagnostic) impose le PDF.
-- Aucune table modifiée : les versions déjà déposées dans un autre format restent sur la fiche, consultables.

update public.diagnostic_settings
   set instructions = replace(replace(replace(instructions,
         $old$Méthode : génère le .pptx avec python-pptx, avec de vraies zones de texte modifiables (jamais une slide en image). Ensuite, convertis le fichier en images (LibreOffice en mode headless, à installer si besoin) et regarde chaque slide : aucun texte qui déborde ou se chevauche, alignements propres, contraste suffisant. Corrige jusqu'à ce que chaque slide soit présentable telle quelle.$old$,
         $new$Méthode : construis le deck avec l'outil de ton choix (python-pptx, HTML…), puis exporte-le en un fichier PDF, une slide par page, au format paysage 16:9 (960 × 540 pt), polices intégrées. Convertis le PDF en images et regarde chaque page : aucun texte qui déborde ou se chevauche, alignements propres, contraste suffisant. Corrige jusqu'à ce que chaque page soit présentable telle quelle. Le livrable est ce PDF : c'est lui que tu déposes.$new$),
         $old$Dépose le fichier avec start_diagnostic_version$old$,
         $new$Dépose le PDF avec start_diagnostic_version$new$),
         $old$génère un PowerPoint modifiable (.pptx) à partir des diagnostics d'exemple$old$,
         $new$génère un PDF (une slide par page, paysage 16:9) à partir des diagnostics d'exemple$new$),
       updated_at = now()
 where id and instructions ~ '\.pptx';
